import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { AMBILIGHT_MODES, DEVICES } from "@/lib/home/catalog";
import { canControlAny, canControlEntity, tokenActor } from "@/lib/home/access";
import { ha } from "@/lib/home/ha-client";
import { drinkGlass, undoGlass } from "@/lib/nutrition/water-actions";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/display/control?k=…   body: one of the commands below
// The Nest Hub kiosk cannot hold a session, so this mirrors the operator
// Server Actions in src/server/actions/home.ts behind the shared display
// token, with the same entity whitelist (only what the UI renders).

const known = new Set<string>(["light.hyperhdr"]);
for (const d of DEVICES) {
  if (d.entity) known.add(d.entity);
  for (const e of d.entities ?? []) known.add(e);
}
const whiteOnly = new Set(DEVICES.filter((d) => d.whiteOnly && d.entity).map((d) => d.entity as string));
const entityId = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).refine((e) => known.has(e), "unknown entity");

const cmd = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle"), entity: entityId, on: z.boolean() }),
  z.object({
    type: z.literal("light"),
    entity: entityId,
    rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).optional(),
    brightnessPct: z.number().int().min(1).max(100).optional(),
    kelvin: z.number().int().min(1500).max(9000).optional(),
  }),
  z.object({
    type: z.literal("climate"),
    entity: entityId,
    hvacMode: z.enum(["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"]).optional(),
    temperature: z.number().min(16).max(30).optional(),
    fanMode: z.string().max(32).optional(),
  }),
  z.object({ type: z.literal("select"), entity: entityId, option: z.string().max(64) }),
  z.object({ type: z.literal("media"), entity: entityId, command: z.enum(["play_pause", "next_track", "previous_track", "volume_up", "volume_down", "volume_mute", "turn_on", "turn_off"]) }),
  z.object({ type: z.literal("ambilight"), mode: z.enum(["movie", "music", "off"]) }),
  z.object({ type: z.literal("water"), ml: z.number().int().min(50).max(1000).default(250) }),
  z.object({ type: z.literal("water_undo") }),
  z.object({ type: z.literal("script"), name: z.enum(["pc_wake", "movie_mode_on", "movie_mode_off", "music_mode"]) }),
  /** The kiosk tells HA whether it is idle so automations (and the Hub's own touch edge) share one flag. */
  z.object({ type: z.literal("idle"), on: z.boolean() }),
]);

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  const p = cmd.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message ?? "bad command" }, { status: 400 });
  const c = p.data;
  const actor = await tokenActor(req);
  if (!actor) return apiError(req, "not_bound", 403);
  const allowed = "entity" in c ? canControlEntity(actor, c.entity) : c.type === "water" || c.type === "water_undo" || canControlAny(actor);
  if (!allowed) return apiError(req, "no_room_access", 403);
  const target = "entity" in c ? c.entity : c.type;
  try {
    let extra: Record<string, unknown> = {};
    switch (c.type) {
      case "toggle": {
        const domain = c.entity.split(".")[0] ?? "homeassistant";
        const svc = ["light", "switch", "fan", "media_player", "climate", "humidifier"].includes(domain) ? domain : "homeassistant";
        await ha.callService(svc, c.on ? "turn_on" : "turn_off", { entity_id: c.entity });
        break;
      }
      case "light": {
        if (c.rgb && whiteOnly.has(c.entity)) throw new Error("white-only light");
        const data: Record<string, unknown> = { entity_id: c.entity, transition: 0.4 };
        if (c.rgb) data.rgb_color = c.rgb;
        if (c.brightnessPct !== undefined) data.brightness_pct = c.brightnessPct;
        if (c.kelvin !== undefined) data.color_temp_kelvin = c.kelvin;
        await ha.callService("light", "turn_on", data);
        break;
      }
      case "climate":
        if (c.hvacMode) await ha.callService("climate", "set_hvac_mode", { entity_id: c.entity, hvac_mode: c.hvacMode });
        if (c.temperature !== undefined) await ha.callService("climate", "set_temperature", { entity_id: c.entity, temperature: c.temperature });
        if (c.fanMode) await ha.callService("climate", "set_fan_mode", { entity_id: c.entity, fan_mode: c.fanMode });
        break;
      case "select":
        await ha.callService("select", "select_option", { entity_id: c.entity, option: c.option });
        break;
      case "media": {
        const svc = c.command === "play_pause" ? "media_play_pause" : c.command === "next_track" ? "media_next_track" : c.command === "previous_track" ? "media_previous_track" : c.command;
        const data: Record<string, unknown> = { entity_id: c.entity };
        if (c.command === "volume_mute") data.is_volume_muted = true;
        await ha.callService("media_player", svc, data);
        break;
      }
      case "ambilight": {
        const m = AMBILIGHT_MODES.find((x) => x.id === c.mode);
        if (!m) throw new Error("unknown mode");
        await ha.runScript(m.script);
        break;
      }
      case "water": {
        const r = await drinkGlass(c.ml, "nest-hub");
        extra = { ml: r.water.ml, target: r.water.targetMl, glasses: r.water.glasses };
        break;
      }
      case "water_undo": {
        const r = await undoGlass("nest-hub");
        extra = { ml: r.water.ml, target: r.water.targetMl, glasses: r.water.glasses };
        break;
      }
      case "script":
        await ha.runScript(c.name);
        break;
      case "idle":
        await ha.callService("input_boolean", c.on ? "turn_on" : "turn_off", { entity_id: "input_boolean.nest_hub_idle" });
        // one row per flip would flood the audit log at 45 s idle cycles
        return NextResponse.json({ ok: true });
    }
    await db.insert(auditLog).values({ accountId: "home", action: `display.${c.type}`, target, status: "ok", message: JSON.stringify(c).slice(0, 400) });
    return NextResponse.json({ ok: true, ...extra });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action: `display.${c.type}`, target, status: "error", message: error });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
