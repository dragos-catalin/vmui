import "server-only";

import { API_VERSION, MIN_CLIENT } from "@/lib/api-version";
import { canControl, canOpenDoor, isOwner, journalUserId, visibleEntities, visibleRooms, type HomeActor } from "@/lib/home/access";
import { controlCommandSchema, mayControl, runControl } from "@/lib/home/control";
import { ha } from "@/lib/home/ha-client";
import { houseDevices, houseRooms } from "@/lib/home/house";
import { armAutoOpen, ignoreCall, intercomState, isAutoOpenArmed, openDoor } from "@/lib/home/intercom";
import { applyScene, setLight, undo } from "@/lib/lights/control";
import * as lights from "@/lib/lights/registry";
import { lightStateSchema, targetSchema } from "@/lib/lights/schema";
import { ack, dismiss, getCard, listCards, localizeCard, localizeCards, markRead, visibleToRole } from "@/lib/notify";
import { nutritionSummary } from "@/lib/nutrition/summary";
import { drinkGlass, undoGlass } from "@/lib/nutrition/water-actions";
import { isLocale, type Locale } from "@/i18n/config";
import { requestLocale } from "@/lib/api-error";
import { z } from "zod";
import { defineRoute, RouteError, type AppRoute } from "./define-route";

// ---------------------------------------------------------------- shared shapes

const okSchema = z.object({ ok: z.literal(true) });
const roleSchema = z.enum(["owner", "adult", "child", "guest"]);
const levelSchema = z.enum(["view", "control"]);

const entityStateSchema = z.object({ state: z.string(), attributes: z.record(z.string(), z.unknown()) });

const waterSchema = z.object({ ml: z.number(), target: z.number(), glasses: z.number(), underPace: z.boolean(), lastAt: z.number().nullable() });

const intercomSchema = z.object({
  ringing: z.boolean(),
  ringingSince: z.number().nullable(),
  lastRingAt: z.number().nullable(),
  lastOpenAt: z.number().nullable(),
  autoOpenUntil: z.number().nullable(),
  armed: z.boolean(),
  canOpen: z.boolean(),
});

const cardSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  subtitle: z.string().nullable(),
  priority: z.string(),
  url: z.string().nullable().optional(),
  actions: z.array(z.object({ id: z.string(), label: z.string(), style: z.string(), url: z.string().optional() })),
  createdAt: z.unknown(),
  readAt: z.unknown().optional(),
});

// ---------------------------------------------------------------- helpers

/** Device language when the app sent one, else the request headers. */
const localeOf = (req: Request): Locale => {
  const q = new URL(req.url).searchParams.get("lang");
  return isLocale(q) ? q : requestLocale(req);
};

const scope = (a: HomeActor) => {
  const uid = journalUserId(a);
  return { uid, isOwner: isOwner(a), scope: uid ? { userId: uid, isOwner: isOwner(a) } : null };
};

/** Every light a target expands to must sit in a room the member controls (the old /api/lights only asked for "some room"). */
function mayControlLights(a: HomeActor, target: string): boolean {
  const resolved = lights.resolveTarget(target);
  return resolved.length > 0 && resolved.every((r) => canControl(a, r.device.room));
}

const toCard = (c: Awaited<ReturnType<typeof localizeCard>>) => ({
  id: c.id,
  kind: c.kind,
  title: c.title,
  body: c.body,
  subtitle: c.subtitle,
  priority: c.priority,
  url: c.url ?? null,
  actions: c.actions.map((x) => ({ id: x.id, label: x.label, style: x.style, ...(x.url ? { url: x.url } : {}) })),
  createdAt: c.createdAt,
  readAt: c.readAt ?? null,
});

// ---------------------------------------------------------------- routes

export const meRoute = defineRoute({
  id: "me",
  method: "GET",
  path: "/api/v1/app/me",
  summary: "Who this device acts as, and what it may do",
  auth: "member",
  output: z.object({
    apiVersion: z.number(),
    minClient: z.number(),
    member: z.object({ displayName: z.string(), role: roleSchema }),
    deviceId: z.string().nullable(),
    rooms: z.record(z.string(), levelSchema),
    can: z.object({ openDoor: z.boolean(), manageHome: z.boolean() }),
  }),
  handler: async ({ actor }) => ({
    apiVersion: API_VERSION,
    minClient: MIN_CLIENT,
    member: { displayName: actor.displayName, role: actor.role },
    deviceId: actor.deviceId,
    rooms: Object.fromEntries(visibleRooms(actor).map((r) => [r, actor.rooms[r] ?? "view"])),
    can: { openDoor: canOpenDoor(actor), manageHome: isOwner(actor) },
  }),
});

export const stateRoute = defineRoute({
  id: "state",
  method: "GET",
  path: "/api/v1/app/state",
  summary: "Rooms, devices and live Home Assistant states the member may see",
  description: "Rooms and devices outside the member's grants are left out entirely. haOnline=false means states is empty and the app should show the last known values.",
  auth: "member",
  output: z.object({
    rooms: z.array(z.object({ id: z.string(), name: z.string(), level: levelSchema })),
    devices: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), room: z.string(), entity: z.string().nullable(), entities: z.array(z.string()) })),
    states: z.record(z.string(), entityStateSchema),
    haOnline: z.boolean(),
  }),
  handler: async ({ actor }) => {
    const seen = visibleEntities(actor);
    const rooms = new Set(visibleRooms(actor));
    const all = await ha.states().catch(() => null);
    const states: Record<string, { state: string; attributes: Record<string, unknown> }> = {};
    for (const s of all ?? []) if (seen.has(s.entity_id)) states[s.entity_id] = { state: s.state, attributes: s.attributes };
    return {
      rooms: houseRooms()
        .filter((r) => rooms.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, level: actor.rooms[r.id] ?? "view" })),
      devices: houseDevices()
        .filter((d) => rooms.has(d.room))
        .map((d) => ({ id: d.id, name: d.name, kind: d.kind, room: d.room, entity: d.entity ?? null, entities: d.entities ?? [] })),
      states,
      haOnline: all !== null,
    };
  },
});

export const controlRoute = defineRoute({
  id: "control",
  method: "POST",
  path: "/api/v1/app/control",
  summary: "Control one device (toggle, light, climate, select, media) or run a house scene",
  description: "Entity commands need control of that entity's room (403 no_room_access otherwise); ambilight and scripts need control of at least one room.",
  auth: "member",
  input: controlCommandSchema,
  output: okSchema,
  handler: async ({ actor, input }) => {
    if (!mayControl(actor, input)) throw new RouteError("no_room_access", 403);
    await runControl(input, "app");
    return { ok: true as const };
  },
});

export const lightsRoute = defineRoute({
  id: "lights",
  method: "GET",
  path: "/api/v1/app/lights",
  summary: "Light registry: devices, groups and scenes in the member's rooms",
  auth: "member",
  output: z.object({
    devices: z.array(z.object({ id: z.string(), name: z.string(), room: z.string(), health: z.string(), segments: z.array(z.object({ id: z.string(), name: z.string() })), capabilities: z.record(z.string(), z.unknown()) })),
    scenes: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  handler: async ({ actor }) => {
    const rooms = new Set(visibleRooms(actor));
    const devices = lights.list().filter((d) => d.enabled && rooms.has(d.room));
    const scenes = lights.listScenes().filter((s) => s.entries.length > 0 && s.entries.every((e) => mayControlLights(actor, e.target)));
    return {
      devices: devices.map((d) => ({ id: d.id, name: d.name, room: d.room, health: String(d.health), segments: d.segments.map((s) => ({ id: s.id, name: s.name })), capabilities: { ...d.capabilities } })),
      scenes: scenes.map((s) => ({ id: s.id, name: s.name })),
    };
  },
});

export const lightsSetRoute = defineRoute({
  id: "lightsSet",
  method: "POST",
  path: "/api/v1/app/lights",
  summary: "Set lights, apply a scene or undo the last change",
  description: "target: dev:<id> | seg:<id> | group:<id> | room:<room> | all. Every light the target expands to must be in a room the member controls.",
  auth: "member",
  input: z.discriminatedUnion("op", [
    z.object({ op: z.literal("set"), target: targetSchema, state: lightStateSchema }),
    z.object({ op: z.literal("scene"), id: z.string().min(1).max(120) }),
    z.object({ op: z.literal("undo") }),
  ]),
  output: z.object({ ok: z.boolean(), applied: z.number() }),
  handler: async ({ actor, input }) => {
    const by = `app:${actor.deviceId ?? actor.userId}`;
    if (input.op === "set") {
      if (!mayControlLights(actor, input.target)) throw new RouteError("no_room_access", 403);
      const r = await setLight(input.target, input.state, by);
      return { ok: r.ok, applied: r.applied.length };
    }
    if (input.op === "scene") {
      const scene = lights.listScenes().find((s) => s.id === input.id);
      if (!scene) throw new RouteError("not_found", 404);
      if (!scene.entries.every((e) => mayControlLights(actor, e.target))) throw new RouteError("no_room_access", 403);
      const r = await applyScene(input.id, by);
      return { ok: r.ok, applied: r.applied.length };
    }
    if (!isOwner(actor)) throw new RouteError("forbidden", 403);
    const r = await undo(by);
    return { ok: r.ok, applied: r.applied.length };
  },
});

export const notifyListRoute = defineRoute({
  id: "notifyList",
  method: "GET",
  path: "/api/v1/app/notify",
  summary: "Notification cards this member may see, rendered in the device language",
  auth: "member",
  input: z.object({ all: z.enum(["0", "1"]).optional(), lang: z.string().optional() }),
  output: z.object({ cards: z.array(cardSchema), now: z.number() }),
  handler: async ({ actor, input, req }) => {
    const all = input.all === "1";
    const visible = (await listCards({ includeDismissed: all, limit: all ? 200 : 100 })).filter((c) => visibleToRole(c.kind, actor.role));
    return { cards: (await localizeCards(visible, localeOf(req))).map(toCard), now: Date.now() };
  },
});

export const notifyActRoute = defineRoute({
  id: "notifyAct",
  method: "POST",
  path: "/api/v1/app/notify",
  summary: "Mark cards read, acknowledge delivery, or dismiss one",
  auth: "member",
  input: z.discriminatedUnion("op", [
    z.object({ op: z.literal("read"), ids: z.array(z.string()).max(200) }),
    z.object({ op: z.literal("ack"), ids: z.array(z.string()).max(50) }),
    z.object({ op: z.literal("dismiss"), id: z.string() }),
  ]),
  output: okSchema,
  handler: async ({ actor, input }) => {
    const by = actor.deviceId ?? actor.userId;
    const mine = async (id: string) => {
      const c = await getCard(id);
      return c !== null && visibleToRole(c.kind, actor.role);
    };
    if (input.op === "dismiss") {
      if (!(await mine(input.id))) throw new RouteError("forbidden", 403);
      await dismiss(input.id, `app:${by}`, "dismiss");
    } else {
      const ids = [];
      for (const id of input.ids) if (await mine(id)) ids.push(id);
      if (input.op === "read") await markRead(ids);
      else for (const id of ids) await ack(id, by);
    }
    return { ok: true as const };
  },
});

const intercomView = (a: HomeActor) => {
  const s = intercomState();
  return { ringing: s.ringingSince !== null, ringingSince: s.ringingSince, lastRingAt: s.lastRingAt, lastOpenAt: s.lastOpenAt, autoOpenUntil: s.autoOpenUntil, armed: isAutoOpenArmed(), canOpen: canOpenDoor(a) };
};

export const intercomGetRoute = defineRoute({
  id: "intercom",
  method: "GET",
  path: "/api/v1/app/intercom",
  summary: "Door intercom state",
  auth: "member",
  output: intercomSchema,
  handler: async ({ actor }) => intercomView(actor),
});

export const intercomActRoute = defineRoute({
  id: "intercomAct",
  method: "POST",
  path: "/api/v1/app/intercom",
  summary: "Open the door, ignore a call, or arm / disarm auto-open",
  description: "Any member may ignore a call; open, arm and disarm need an owner or adult (403 forbidden).",
  auth: "member",
  input: z.object({ action: z.enum(["open", "ignore", "arm", "disarm"]), minutes: z.number().int().min(1).max(240).default(45) }),
  output: intercomSchema.extend({ ok: z.boolean() }),
  handler: async ({ actor, input }) => {
    const by = `app:${actor.displayName || actor.userId}`.slice(0, 40);
    if (input.action !== "ignore" && !canOpenDoor(actor)) throw new RouteError("forbidden", 403);
    let ok = true;
    if (input.action === "open") ok = (await openDoor(by)).ok;
    else if (input.action === "ignore") await ignoreCall(by);
    else await armAutoOpen(input.action === "arm" ? input.minutes : 0, by);
    return { ok, ...intercomView(actor) };
  },
});

export const waterGetRoute = defineRoute({
  id: "water",
  method: "GET",
  path: "/api/v1/app/nutrition/water",
  summary: "Today's water for this member",
  auth: "member",
  output: waterSchema,
  handler: async ({ actor }) => {
    const w = (await nutritionSummary(scope(actor).scope)).water;
    return { ml: w.ml, target: w.targetMl, glasses: w.glasses, underPace: w.underPace, lastAt: w.lastAt };
  },
});

export const waterActRoute = defineRoute({
  id: "waterAct",
  method: "POST",
  path: "/api/v1/app/nutrition/water",
  summary: "Log a glass of water, or undo the newest one",
  auth: "member",
  input: z.object({ op: z.enum(["drink", "undo"]).default("drink"), ml: z.number().int().min(25).max(2000).default(250) }),
  output: waterSchema.omit({ lastAt: true }),
  handler: async ({ actor, input }) => {
    const s = scope(actor);
    const r = input.op === "drink" ? await drinkGlass(input.ml, "app", s.uid, s.isOwner) : await undoGlass("app", s.uid, s.isOwner);
    return { ml: r.water.ml, target: r.water.targetMl, glasses: r.water.glasses, underPace: r.water.underPace };
  },
});

export const nutritionTodayRoute = defineRoute({
  id: "nutritionToday",
  method: "GET",
  path: "/api/v1/app/nutrition/today",
  summary: "Today's calories, macros, meals and water for this member",
  auth: "member",
  output: z.object({
    day: z.string(),
    targets: z.record(z.string(), z.unknown()),
    today: z.record(z.string(), z.unknown()),
    remaining: z.object({ calories: z.number(), protein: z.number(), carbs: z.number(), fats: z.number() }),
    meals: z.array(z.object({ id: z.unknown(), name: z.string(), mealType: z.string().nullable(), calories: z.number(), protein: z.number(), carbs: z.number(), fats: z.number(), at: z.number() })),
    streak: z.number(),
  }),
  handler: async ({ actor }) => {
    const s = await nutritionSummary(scope(actor).scope);
    return {
      day: s.day,
      targets: { ...s.targets },
      today: { ...s.today },
      remaining: s.remaining,
      meals: s.meals.map((m) => ({ id: m.id, name: m.name, mealType: m.mealType ?? null, calories: m.calories, protein: m.protein, carbs: m.carbs, fats: m.fats, at: m.at })),
      streak: s.streak,
    };
  },
});

/** Every /api/v1/app operation, in a stable order (OpenAPI, tests, route files). */
export const APP_ROUTES: readonly AppRoute[] = [
  meRoute,
  stateRoute,
  controlRoute,
  lightsRoute,
  lightsSetRoute,
  notifyListRoute,
  notifyActRoute,
  intercomGetRoute,
  intercomActRoute,
  waterGetRoute,
  waterActRoute,
  nutritionTodayRoute,
] as unknown as readonly AppRoute[];
