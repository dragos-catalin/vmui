"use server";

import { copilotSignalsSchema, saveCopilotSignals, type CopilotEvent, type CopilotSignals } from "@/lib/copilot/signals";
import { db } from "@/lib/db";
import { auditLog, homeLayout } from "@/lib/db/schema";
import { displaySettingsSchema, saveDisplaySettings, type DisplaySettings } from "@/lib/display/settings";
import { canControlAny, HomeAccessError, requireEntityControl, requireHomeActor, requireOwner, type HomeActor } from "@/lib/home/access";
import { setAmbilightSettings } from "@/lib/home/ambilight-settings";
import { AMBILIGHT_MODES } from "@/lib/home/catalog";
import { houseDevices, houseEntities, houseRooms } from "@/lib/home/house";
import { applianceAuthHeaders } from "@/lib/esp/auth";
import { ha } from "@/lib/home/ha-client";
import { loadPomodoro, loadTurzxSettings, POMODORO_IDLE, savePomodoro, saveTurzxSettings, turzxSettingsSchema, type TurzxSettings } from "@/lib/turzx/settings";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Result = { ok: true } | { ok: false; error: string };

/** House-wide features (ambilight scenes, wall colour, pomodoro): control in at least one room. */
async function requireAnyControl(): Promise<HomeActor> {
  const a = await requireHomeActor();
  if (!canControlAny(a)) throw new HomeAccessError();
  return a;
}

const by = (a: HomeActor) => (a.email ? ` by ${a.email}` : "");

async function audit(action: string, target: string, message: string, status: "ok" | "error" = "ok") {
  await db.insert(auditLog).values({ accountId: "home", action, target, status, message });
}

/** Gate first (its failure is audited as an error and returned), then the work. */
async function run(action: string, target: string, message: string, fn: () => Promise<unknown>, gate: () => Promise<HomeActor> = requireAnyControl): Promise<Result> {
  let actor: HomeActor;
  try {
    actor = await gate();
  } catch (e) {
    const error = e instanceof Error ? e.message : "Not authorized";
    await audit(action, target, error, "error");
    return { ok: false, error };
  }
  try {
    await fn();
    await audit(action, target, `${message}${by(actor)}`);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await audit(action, target, `${error}${by(actor)}`, "error");
    return { ok: false, error };
  }
}

const entityId = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);
const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

const isKnownEntity = (e: string) => e === "light.hyperhdr" || houseEntities().has(e);
const isWhiteOnly = (e: string) => houseDevices().some((d) => d.whiteOnly && d.entity === e);

function assertKnown(entity: string) {
  // Only the entities this UI renders may be driven from here. Anything else
  // is a typo or a probe, and HA's own UI is the right place for it.
  if (!isKnownEntity(entity)) throw new Error(`Unknown entity ${entity}`);
}

export async function toggleEntityAction(input: { entity: string; on: boolean }): Promise<Result> {
  const p = z.object({ entity: entityId, on: z.boolean() }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const { entity, on } = p.data;
  const domain = entity.split(".")[0] ?? "homeassistant";
  return run(
    "home.toggle",
    entity,
    on ? "on" : "off",
    async () => {
      assertKnown(entity);
      const svcDomain = ["light", "switch", "fan", "media_player", "climate", "humidifier"].includes(domain) ? domain : "homeassistant";
      await ha.callService(svcDomain, on ? "turn_on" : "turn_off", { entity_id: entity });
    },
    () => requireEntityControl(entity),
  );
}

export async function setLightAction(input: {
  entity: string;
  rgb?: [number, number, number];
  brightnessPct?: number;
  kelvin?: number;
  transition?: number;
}): Promise<Result> {
  const p = z
    .object({
      entity: entityId,
      rgb: rgb.optional(),
      brightnessPct: z.number().int().min(1).max(100).optional(),
      kelvin: z.number().int().min(1500).max(9000).optional(),
      transition: z.number().min(0).max(10).optional(),
    })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const { entity, rgb: color, brightnessPct, kelvin, transition } = p.data;
  return run(
    "home.light",
    entity,
    JSON.stringify({ color, brightnessPct, kelvin }),
    async () => {
      assertKnown(entity);
      if (color && isWhiteOnly(entity)) throw new Error("This light only supports white — use Warmth instead");
      const data: Record<string, unknown> = { entity_id: entity };
      if (color) data.rgb_color = color;
      if (brightnessPct !== undefined) data.brightness_pct = brightnessPct;
      if (kelvin !== undefined) data.color_temp_kelvin = kelvin;
      if (transition !== undefined) data.transition = transition;
      await ha.callService("light", "turn_on", data);
    },
    () => requireEntityControl(entity),
  );
}

export async function setClimateAction(input: {
  entity: string;
  hvacMode?: "off" | "cool" | "heat" | "dry" | "fan_only" | "auto" | "heat_cool";
  temperature?: number;
  fanMode?: string;
}): Promise<Result> {
  const p = z
    .object({
      entity: entityId,
      hvacMode: z.enum(["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"]).optional(),
      temperature: z.number().min(16).max(30).optional(),
      fanMode: z.string().max(32).optional(),
    })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const { entity, hvacMode, temperature, fanMode } = p.data;
  return run(
    "home.climate",
    entity,
    JSON.stringify({ hvacMode, temperature, fanMode }),
    async () => {
      assertKnown(entity);
      if (hvacMode) await ha.callService("climate", "set_hvac_mode", { entity_id: entity, hvac_mode: hvacMode });
      if (temperature !== undefined) await ha.callService("climate", "set_temperature", { entity_id: entity, temperature });
      if (fanMode) await ha.callService("climate", "set_fan_mode", { entity_id: entity, fan_mode: fanMode });
    },
    () => requireEntityControl(entity),
  );
}

export async function selectOptionAction(input: { entity: string; option: string }): Promise<Result> {
  const p = z.object({ entity: entityId, option: z.string().max(64) }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const { entity, option } = p.data;
  return run(
    "home.select",
    entity,
    option,
    async () => {
      assertKnown(entity);
      await ha.callService("select", "select_option", { entity_id: entity, option });
    },
    () => requireEntityControl(entity),
  );
}

export async function mediaCommandAction(input: { entity: string; command: "play_pause" | "volume_up" | "volume_down" | "volume_mute" | "turn_on" | "turn_off" }): Promise<Result> {
  const p = z.object({ entity: entityId, command: z.enum(["play_pause", "volume_up", "volume_down", "volume_mute", "turn_on", "turn_off"]) }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const { entity, command } = p.data;
  return run(
    "home.media",
    entity,
    command,
    async () => {
      assertKnown(entity);
      const svc = command === "play_pause" ? "media_play_pause" : command;
      const data: Record<string, unknown> = { entity_id: entity };
      if (command === "volume_mute") data.is_volume_muted = true;
      await ha.callService("media_player", svc, data);
    },
    () => requireEntityControl(entity),
  );
}

export async function setAmbilightModeAction(mode: string): Promise<Result> {
  const m = AMBILIGHT_MODES.find((x) => x.id === mode);
  if (!m) return { ok: false, error: "Unknown mode" };
  return run("ambilight.mode", m.id, m.name, () => ha.runScript(m.script));
}

export async function runHyperEffectAction(input: { effect: string; priority?: number }): Promise<Result> {
  const p = z.object({ effect: z.string().min(1).max(80), priority: z.number().int().min(1).max(250).default(40) }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  return run("ambilight.effect", p.data.effect, `prio ${p.data.priority}`, () =>
    ha.ambilightAll([{ command: "effect", effect: { name: p.data.effect }, priority: p.data.priority }]),
  );
}

export async function clearHyperPriorityAction(priority: number): Promise<Result> {
  const p = z.number().int().min(1).max(250).safeParse(priority);
  if (!p.success) return { ok: false, error: "Invalid input" };
  return run("ambilight.clear", String(p.data), "clear", () => ha.ambilightAll([{ command: "clear", priority: p.data }]));
}

export async function notifyFlashAction(input: { color: [number, number, number]; durationMs?: number }): Promise<Result> {
  const p = z.object({ color: rgb, durationMs: z.number().int().min(200).max(15000).default(1500) }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  return run("ambilight.flash", p.data.color.join(","), `${p.data.durationMs}ms`, () =>
    ha.runScript("notify_flash", { color: p.data.color, duration_ms: p.data.durationMs }),
  );
}

export async function setGrabberAction(enabled: boolean): Promise<Result> {
  return run("ambilight.grabber", enabled ? "on" : "off", "SYSTEMGRABBER", () =>
    ha.ambilightAll([{ command: "componentstate", componentstate: { component: "SYSTEMGRABBER", state: enabled } }]),
  );
}

/**
 * Wall compensation for the monitor strip. Persisted in ambilight/settings.json
 * and applied by scripts/ambilight.ps1 -Set (the same writer the logon tasks
 * and the CLI use), so HyperHDR restarts keep the correction.
 */
export async function setWallCompensationAction(input: { wallHex: string; strength: number }): Promise<Result> {
  const p = z
    .object({ wallHex: z.string().regex(/^#[0-9a-fA-F]{6}$/), strength: z.number().min(0).max(1) })
    .safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid wall colour or strength" };
  const { wallHex, strength } = p.data;
  return run("ambilight.wall", "instance-0", `${wallHex} @ ${Math.round(strength * 100)}%`, async () => {
    await setAmbilightSettings({ wallHex: wallHex.toLowerCase(), wallStrength: Math.round(strength * 100) / 100 });
    revalidatePath("/home");
  });
}

/** Turzx desk-screen preferences; the renderer picks them up within ~3 s. */
export async function saveTurzxSettingsAction(input: TurzxSettings): Promise<Result> {
  const p = turzxSettingsSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid settings" };
  return run(
    "turzx.settings",
    "turzx",
    `${p.data.views.filter((v) => v.enabled).length} views on, ${p.data.fps}fps`,
    async () => {
      await saveTurzxSettings(p.data);
      revalidatePath("/home");
    },
    requireOwner,
  );
}

/** Nest Hub kiosk preferences; /display polls them within ~3 s. */
export async function saveDisplaySettingsAction(input: DisplaySettings): Promise<Result> {
  const p = displaySettingsSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid settings" };
  return run(
    "display.settings",
    "nest-hub",
    `${p.data.views.filter((v) => v.enabled).length} views on, photo ${p.data.photoSec}s`,
    async () => {
      await saveDisplaySettings(p.data);
      revalidatePath("/home");
    },
    requireOwner,
  );
}

/** Pomodoro on the desk screen: start work, skip to break, or stop. */
export async function saveCopilotSignalsAction(input: CopilotSignals): Promise<Result> {
  const p = copilotSignalsSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid settings" };
  return run(
    "copilot.settings",
    "copilot",
    `${p.data.lights.length} lights, ${Object.values(p.data.patterns).filter((x) => x.enabled).length} events on`,
    async () => {
      await saveCopilotSignals(p.data);
      revalidatePath("/home");
    },
    requireOwner,
  );
}

/** Fire one event through the same path the hooks use, so the UI test button proves the whole chain. */
export async function testCopilotSignalAction(event: CopilotEvent): Promise<Result> {
  const p = z.enum(["ask", "done", "blocked", "failed"]).safeParse(event);
  if (!p.success) return { ok: false, error: "Invalid event" };
  return run(
    "copilot.test",
    "copilot",
    p.data,
    async () => {
      const auth = applianceAuthHeaders("pcAgent");
      if (!Object.keys(auth).length) throw new Error("appliance token missing");
      const port = process.env.PORT ?? "3737";
      const r = await fetch(`http://127.0.0.1:${port}/api/copilot/event`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ event: p.data, text: "test din mui", source: "mui" }),
      });
      if (!r.ok) throw new Error(`event endpoint ${r.status}`);
      if (p.data === "ask") {
        // A test `ask` must not strobe forever: cancel it after 6 s.
        setTimeout(() => {
          fetch(`http://127.0.0.1:${port}/api/copilot/event`, { method: "DELETE", headers: auth }).catch(() => undefined);
        }, 6000);
      }
    },
    requireOwner,
  );
}

export async function pomodoroAction(cmd: "start" | "break" | "stop"): Promise<Result> {
  const p = z.enum(["start", "break", "stop"]).safeParse(cmd);
  if (!p.success) return { ok: false, error: "Invalid command" };
  return run("turzx.pomodoro", "turzx", p.data, async () => {
    const s = await loadTurzxSettings();
    const o = s.views.find((v) => v.id === "pomodoro")?.options ?? {};
    const workMin = typeof o.workMin === "number" ? o.workMin : 25;
    const breakMin = typeof o.breakMin === "number" ? o.breakMin : 5;
    const cur = await loadPomodoro();
    const now = Date.now();
    if (p.data === "stop") await savePomodoro(POMODORO_IDLE);
    else if (p.data === "start") await savePomodoro({ phase: "work", startedAt: now, endsAt: now + workMin * 60_000, round: cur.phase === "idle" ? 1 : cur.round + 1 });
    else await savePomodoro({ phase: "break", startedAt: now, endsAt: now + breakMin * 60_000, round: cur.round });
    revalidatePath("/home");
  });
}

export async function placeDeviceAction(input: { deviceId: string; room: string; x: number; y: number }): Promise<Result> {
  const p = z
    .object({
      deviceId: z.string().refine((id) => houseDevices().some((d) => d.id === id), "Unknown device"),
      room: z.string().refine((r) => houseRooms().some((x) => x.id === r), "Unknown room"),
      x: z.number().min(0).max(100),
      y: z.number().min(0).max(100),
    })
    .safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues.map((i) => i.message).join("; ") };
  const { deviceId, room, x, y } = p.data;
  try {
    await requireOwner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized" };
  }
  await db
    .insert(homeLayout)
    .values({ deviceId, room, x, y })
    .onConflictDoUpdate({ target: homeLayout.deviceId, set: { room, x, y, updatedAt: new Date() } });
  revalidatePath("/home");
  return { ok: true };
}

export async function resetLayoutAction(): Promise<Result> {
  return run(
    "home.layout.reset",
    "home_layout",
    "defaults restored",
    async () => {
      await db.delete(homeLayout);
      revalidatePath("/home");
    },
    requireOwner,
  );
}
