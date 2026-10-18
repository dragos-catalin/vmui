import { db } from "@/lib/db";
import { auditLog, lightStateLog } from "@/lib/db/schema";
import { ha, type HaState } from "@/lib/home/ha-client";
import { desc, eq } from "drizzle-orm";
import "server-only";
import { LightError } from "./i18n";
import { applyBrightness, applyCalibration, composeCalibration, downgrade, type LightDevice, type LightState, type Segment } from "./model";
import { activeProfile, getScene, mustGet, recordHealth, resolveTarget, saveScene, updateDevice, type LightScene, type ResolvedTarget, type SceneEntry } from "./registry";
import type { DiscoveredItem } from "./schema";

// Driving lights. HA lights go through light.turn_on/off; PC-owned lights (BLE via
// ambilight/ble_lights.py, HyperHDR instances) go through the same MQTT relay as
// /api/desktop/pc: HA mqtt.publish on vmui/pc/cmd, read back from sensor.vmui_pc_agent.

const PC_SENSOR = "sensor.vmui_pc_agent";
const PC_FRESH_S = 90;
const HYPER_PRIORITY = 40;

export type Via = "ha" | "ha_alias" | "pc_ble" | "pc_hyper";
export type Applied = { deviceId: string; segmentId?: string; via: Via | null; latencyMs: number; error?: string };
export type SetResult = { ok: boolean; applied: Applied[] };

export type PcStatus = { online: boolean; seenAgo: number | null; ble: Array<{ mac: string; connected: boolean; rssi?: number; latencyMs?: number; error?: string }> };

export function pcStatusFrom(s: HaState | null | undefined): PcStatus {
  const a = (s?.attributes ?? {}) as Record<string, unknown>;
  const seen = typeof a.at === "number" ? a.at : 0;
  const now = Date.now() / 1000;
  const ble = Array.isArray(a.ble) ? (a.ble as PcStatus["ble"]).filter((b) => b && typeof b.mac === "string") : [];
  return { online: s?.state === "online" && now - seen < PC_FRESH_S, seenAgo: seen ? Math.round(now - seen) : null, ble };
}

export async function pcStatus(states?: HaState[] | null): Promise<PcStatus> {
  const s = states ? states.find((x) => x.entity_id === PC_SENSOR) : await ha.state(PC_SENSOR).catch(() => null);
  return pcStatusFrom(s);
}

export function stateFromHa(s: HaState | undefined): LightState | null {
  if (!s || s.state === "unavailable" || s.state === "unknown") return null;
  if (s.state !== "on") return { on: false };
  const a = s.attributes;
  const out: LightState = { on: true };
  const rgb = a.rgb_color;
  if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => typeof v === "number")) out.rgb = [rgb[0], rgb[1], rgb[2]] as [number, number, number];
  if (typeof a.brightness === "number") out.brightnessPct = Math.round((a.brightness / 255) * 100);
  if (typeof a.color_temp_kelvin === "number" && a.color_mode === "color_temp") out.kelvin = a.color_temp_kelvin;
  if (typeof a.effect === "string" && a.effect !== "None" && a.effect !== "off") out.effect = a.effect;
  return out;
}

const targetKey = (r: ResolvedTarget) => (r.segment ? `seg:${r.segment.id}` : `dev:${r.device.id}`);

function lastLogged(target: string): LightState | null {
  const row = db.select({ after: lightStateLog.after }).from(lightStateLog).where(eq(lightStateLog.target, target)).orderBy(desc(lightStateLog.id)).limit(1).get();
  if (!row) return null;
  try {
    return JSON.parse(row.after) as LightState;
  } catch {
    return null;
  }
}

/** Last known state of a device: HA (own entity or alias) when available, else the last thing we sent. */
export function knownState(device: LightDevice, states: HaState[] | null, segment?: Segment): LightState | null {
  const entity = device.transport === "ha" ? device.address : device.haEntity;
  if (entity && states && !segment) {
    const s = stateFromHa(states.find((x) => x.entity_id === entity));
    if (s) return s;
  }
  return lastLogged(segment ? `seg:${segment.id}` : `dev:${device.id}`);
}

function pcCmd(body: Record<string, unknown>) {
  const id = Math.random().toString(36).slice(2, 10);
  const payload = JSON.stringify({ id, ...body, at: Math.floor(Date.now() / 1000) });
  return ha.callService("mqtt", "publish", { topic: "vmui/pc/cmd", payload, qos: 1 }).then(() => id);
}

type Encoded = { on: boolean; rgb?: [number, number, number]; bri?: number; kelvin?: number; effect?: string };

/** downgrade by caps -> calibration (device x segment x active profile) -> wire values. */
export function encode(device: LightDevice, segment: Segment | undefined, state: LightState): Encoded {
  const s = downgrade(state, device.capabilities);
  if (!s.on) return { on: false };
  const cal = composeCalibration(device.calibration, segment?.calibration, activeProfile()?.calibration);
  const out: Encoded = { on: true };
  if (s.rgb) out.rgb = applyCalibration(s.rgb, cal);
  if (s.brightnessPct !== undefined || cal.briCap !== undefined) out.bri = applyBrightness(s.brightnessPct ?? 100, cal);
  if (s.kelvin !== undefined) {
    const k = s.kelvin + (cal.kelvinOffset ?? 0);
    out.kelvin = device.capabilities.kelvin ? Math.min(device.capabilities.kelvin[1], Math.max(device.capabilities.kelvin[0], k)) : k;
  }
  if (s.effect) out.effect = s.effect;
  return out;
}

async function haDrive(entity: string, e: Encoded) {
  if (!e.on) return ha.callService("light", "turn_off", { entity_id: entity });
  const data: Record<string, unknown> = { entity_id: entity };
  if (e.rgb) data.rgb_color = e.rgb;
  if (e.bri !== undefined) data.brightness_pct = e.bri;
  if (e.kelvin !== undefined && !e.rgb) data.color_temp_kelvin = e.kelvin;
  if (e.effect) data.effect = e.effect;
  return ha.callService("light", "turn_on", data);
}

async function drive(r: ResolvedTarget, e: Encoded, pc: PcStatus): Promise<Via> {
  const { device, segment } = r;
  const fallback = async (): Promise<Via> => {
    if (!device.haEntity) throw new LightError(device.transport === "ble" || device.transport === "hyperhdr" ? "pcOffline" : "unsupportedTransport", { transport: device.transport });
    await haDrive(device.haEntity, e);
    return "ha_alias";
  };
  switch (device.transport) {
    case "ha":
      await haDrive(device.address, e);
      return "ha";
    case "ble":
      if (!pc.online) return fallback();
      await pcCmd({
        action: "light",
        device: { mac: device.address, protocol: device.protocol ?? "melk" },
        ...(segment ? { segment: { start: segment.ledStart, count: segment.ledCount } } : {}),
        state: { on: e.on, ...(e.rgb ? { rgb: e.rgb } : {}), ...(e.bri !== undefined ? { bri: e.bri } : {}), ...(e.effect ? { effect: e.effect } : {}) },
      });
      return "pc_ble";
    case "hyperhdr": {
      if (!pc.online) return fallback();
      const instance = Number(device.address);
      const scale = (e.bri ?? 100) / 100;
      const color = (e.rgb ?? [255, 255, 255]).map((v) => Math.round(v * scale));
      const commands = e.on
        ? [{ command: "color", color, priority: HYPER_PRIORITY, origin: "vmui-lights" }]
        : [{ command: "clear", priority: HYPER_PRIORITY }];
      await pcCmd({ action: "hyper", commands, instances: Number.isInteger(instance) ? [instance] : [] });
      return "pc_hyper";
    }
    default:
      return fallback();
  }
}

async function haStatesOrNull(): Promise<HaState[] | null> {
  return ha.states().catch(() => null);
}

async function audit(action: string, target: string, status: "ok" | "error", message: string) {
  await db.insert(auditLog).values({ accountId: "lights", action, target, status, message: message.slice(0, 500) });
}

/** Apply already-resolved pairs; one log row per pair, one audit row per call. */
async function applyResolved(target: string, pairs: ResolvedTarget[], perPair: (r: ResolvedTarget) => LightState, actor: string, action = "lights.set"): Promise<SetResult> {
  const states = await haStatesOrNull();
  const pc = await pcStatus(states);
  const ts = Date.now();
  const applied = await Promise.all(
    pairs.map(async (r): Promise<Applied> => {
      const want = perPair(r);
      const before = knownState(r.device, states, r.segment);
      const t0 = performance.now();
      const base = { deviceId: r.device.id, ...(r.segment ? { segmentId: r.segment.id } : {}) };
      try {
        const via = await drive(r, encode(r.device, r.segment, want), pc);
        const latencyMs = Math.round(performance.now() - t0);
        recordHealth(r.device.id, { health: "ok", latencyMs, error: null, seen: true });
        const after = downgrade(want, r.device.capabilities);
        db.insert(lightStateLog).values({ ts, target: targetKey(r), before: before ? JSON.stringify(before) : null, after: JSON.stringify(after), actor }).run();
        return { ...base, via, latencyMs };
      } catch (e) {
        const latencyMs = Math.round(performance.now() - t0);
        const error = e instanceof LightError ? e.code : e instanceof Error ? e.message : String(e);
        recordHealth(r.device.id, { health: e instanceof LightError && e.code === "pcOffline" ? "offline" : "degraded", latencyMs, error });
        return { ...base, via: null, latencyMs, error };
      }
    }),
  );
  const ok = applied.every((a) => !a.error);
  await audit(action, target, ok ? "ok" : "error", `[${actor}] ${JSON.stringify(applied.map((a) => ({ d: a.deviceId, s: a.segmentId, via: a.via, ms: a.latencyMs, e: a.error })))}`);
  return { ok, applied };
}

export async function setLight(target: string, state: LightState, actor: string): Promise<SetResult> {
  const pairs = resolveTarget(target);
  if (!pairs.length) throw new LightError("noDevices", { target });
  return applyResolved(target, pairs, () => state, actor);
}

/** Snapshot the current state of every light the targets expand to. */
export async function captureScene(name: string, targets: string[]): Promise<LightScene> {
  const states = await haStatesOrNull();
  const entries: SceneEntry[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    for (const r of resolveTarget(t)) {
      const key = targetKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      const state = knownState(r.device, states, r.segment);
      if (state) entries.push({ target: key, state });
    }
  }
  if (!entries.length) throw new LightError("noDevices", { target: targets.join(",") });
  return saveScene(name, entries);
}

export async function applyScene(id: string, actor: string): Promise<SetResult> {
  const scene = getScene(id);
  const pairs: ResolvedTarget[] = [];
  const want = new Map<string, LightState>();
  for (const e of scene.entries) {
    for (const r of resolveTarget(e.target)) {
      pairs.push(r);
      want.set(targetKey(r), e.state);
    }
  }
  if (!pairs.length) throw new LightError("noDevices", { target: `scene:${id}` });
  return applyResolved(`scene:${id}`, pairs, (r) => want.get(targetKey(r)) ?? { on: false }, actor, "lights.scene");
}

/** Re-apply the `before` of the newest call (every row sharing its ts). A second undo redoes. */
export async function undo(actor: string): Promise<SetResult> {
  const last = db.select({ ts: lightStateLog.ts }).from(lightStateLog).orderBy(desc(lightStateLog.id)).limit(1).get();
  if (!last) throw new LightError("nothingToUndo");
  const rows = db.select().from(lightStateLog).where(eq(lightStateLog.ts, last.ts)).all().filter((r) => r.before);
  const pairs: Array<{ pair: ResolvedTarget; state: LightState }> = [];
  for (const row of rows) {
    const pair = resolveTarget(row.target)[0];
    if (!pair || !row.before) continue;
    try {
      pairs.push({ pair, state: JSON.parse(row.before) as LightState });
    } catch {
      /* corrupt row: skip */
    }
  }
  if (!pairs.length) throw new LightError("nothingToUndo");
  const map = new Map(pairs.map((p) => [targetKey(p.pair), p.state]));
  return applyResolved("undo", pairs.map((p) => p.pair), (r) => map.get(targetKey(r)) ?? { on: false }, `undo:${actor}`, "lights.undo");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Three white blinks, then back to what it was. Not logged as a state change. */
export async function identify(id: string, actor: string): Promise<SetResult> {
  const device = mustGet(id);
  const states = await haStatesOrNull();
  const pc = await pcStatus(states);
  const before = knownState(device, states) ?? { on: false };
  const r: ResolvedTarget = { device };
  const t0 = performance.now();
  let via: Via | null = null;
  let error: string | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      via = await drive(r, encode(device, undefined, { on: true, rgb: [255, 255, 255], brightnessPct: 100, kelvin: 4000 }), pc);
      await sleep(350);
      await drive(r, { on: false }, pc);
      await sleep(350);
    }
    await drive(r, encode(device, undefined, before), pc);
  } catch (e) {
    error = e instanceof LightError ? e.code : e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Math.round(performance.now() - t0);
  await audit("lights.identify", `dev:${id}`, error ? "error" : "ok", `[${actor}] via=${via ?? "-"}${error ? ` ${error}` : ""}`);
  return { ok: !error, applied: [{ deviceId: id, via, latencyMs, ...(error ? { error } : {}) }] };
}

function requireBlePc(device: LightDevice, pc: PcStatus) {
  if (device.transport !== "ble") throw new LightError("notBle");
  if (!pc.online) throw new LightError("pcOffline");
}

/** Program the strip controller's LED count (MELK 7e0721…) through the PC, then store it. */
export async function setLedCount(deviceId: string, count: number, actor: string): Promise<{ ok: true; id: string; device: LightDevice }> {
  const device = mustGet(deviceId);
  requireBlePc(device, await pcStatus());
  const id = await pcCmd({ action: "led_count", mac: device.address, protocol: device.protocol ?? "melk", count });
  const updated = updateDevice(deviceId, { ledCount: count });
  await audit("lights.led_count", `dev:${deviceId}`, "ok", `[${actor}] ${count}`);
  return { ok: true, id, device: updated };
}

/**
 * LED-count wizard / segment check: light the first `step` LEDs of the device (or of a
 * segment) white with a moving `test_pattern` effect so the user can see where it ends.
 */
export async function testPattern(deviceId: string, segmentId: string | undefined, step: number, actor: string): Promise<{ ok: true; id: string }> {
  const device = mustGet(deviceId);
  requireBlePc(device, await pcStatus());
  const segment = segmentId ? device.segments.find((s) => s.id === segmentId) : undefined;
  const start = segment?.ledStart ?? 0;
  const count = Math.max(1, Math.min(step, segment?.ledCount ?? 5000));
  const id = await pcCmd({
    action: "light",
    device: { mac: device.address, protocol: device.protocol ?? "melk" },
    segment: { start, count },
    state: { on: true, rgb: [255, 255, 255], bri: 100, effect: "test_pattern" },
    pattern: { kind: "chase", step },
  });
  await audit("lights.test_pattern", segmentId ? `seg:${segmentId}` : `dev:${deviceId}`, "ok", `[${actor}] step=${step}`);
  return { ok: true, id };
}

// --- BLE discovery results posted by the PC (kept in memory for 10 min) ----

const DISCOVERY_TTL_MS = 10 * 60_000;
const discovered = new Map<string, DiscoveredItem & { at: number }>();

export function storeDiscovered(items: DiscoveredItem[]): number {
  const at = Date.now();
  for (const it of items) discovered.set(it.mac.toUpperCase(), { ...it, mac: it.mac.toUpperCase(), at });
  return items.length;
}

export function listDiscovered(): Array<DiscoveredItem & { at: number }> {
  const now = Date.now();
  for (const [k, v] of discovered) if (now - v.at > DISCOVERY_TTL_MS) discovered.delete(k);
  return [...discovered.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}
