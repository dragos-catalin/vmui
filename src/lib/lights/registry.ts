import { db } from "@/lib/db";
import { lightDevices, lightGroupMembers, lightGroups, lightProfiles, lightScenes, lightSegments, type LightDeviceRow, type LightSegmentRow } from "@/lib/db/schema";
import { DEVICES } from "@/lib/home/catalog";
import { ha, type HaState } from "@/lib/home/ha-client";
import { asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import "server-only";
import { LightError } from "./i18n";
import { appendSegment, withSegmentStarts, type Calibration, type Capabilities, type LightDevice, type LightState, type Segment } from "./model";
import {
  calibrationSchema,
  capabilitiesSchema,
  deviceInputSchema,
  registryExportSchema,
  type DeviceInput,
  type DevicePatch,
  type RegistryExport,
  type SegmentPatch,
} from "./schema";

// The light registry: SQLite rows <-> model types. Pure CRUD + seeding; driving
// the lights lives in control.ts.

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const parseCal = (raw: string | null | undefined): Calibration => {
  const r = calibrationSchema.safeParse(parseJson(raw, {}));
  return r.success ? (r.data as Calibration) : {};
};

const parseCaps = (raw: string): Capabilities => capabilitiesSchema.parse(parseJson(raw, {})) as Capabilities;

const HEALTH = new Set(["ok", "degraded", "offline", "unknown"]);

function toSegments(rows: LightSegmentRow[]): Segment[] {
  return withSegmentStarts(
    rows.map((s) => ({ id: s.id, deviceId: s.deviceId, ord: s.ord, name: s.name, ledCount: s.ledCount, reverse: s.reverse, calibration: parseCal(s.calibration) })),
  );
}

function toDevice(row: LightDeviceRow, segRows: LightSegmentRow[]): LightDevice {
  const segments = toSegments(segRows);
  return {
    id: row.id,
    name: row.name,
    room: row.room,
    transport: row.transport,
    address: row.address,
    protocol: row.protocol,
    haEntity: row.haEntity,
    capabilities: parseCaps(row.capabilities),
    calibration: parseCal(row.calibration),
    ledCount: segments.length ? segments.reduce((n, s) => n + s.ledCount, 0) : row.ledCount,
    segments,
    enabled: row.enabled,
    health: (HEALTH.has(row.health) ? row.health : "unknown") as LightDevice["health"],
    lastSeenAt: row.lastSeenAt,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    state: null,
  };
}

export function list(): LightDevice[] {
  const rows = db.select().from(lightDevices).orderBy(asc(lightDevices.room), asc(lightDevices.name)).all();
  const segs = db.select().from(lightSegments).orderBy(asc(lightSegments.ord)).all();
  const byDev = new Map<string, LightSegmentRow[]>();
  for (const s of segs) byDev.set(s.deviceId, [...(byDev.get(s.deviceId) ?? []), s]);
  return rows.map((r) => toDevice(r, byDev.get(r.id) ?? []));
}

export function get(id: string): LightDevice | null {
  const row = db.select().from(lightDevices).where(eq(lightDevices.id, id)).get();
  if (!row) return null;
  return toDevice(row, db.select().from(lightSegments).where(eq(lightSegments.deviceId, id)).orderBy(asc(lightSegments.ord)).all());
}

export function mustGet(id: string): LightDevice {
  const d = get(id);
  if (!d) throw new LightError("deviceNotFound", { id });
  return d;
}

export function isEmpty(): boolean {
  return !db.select({ id: lightDevices.id }).from(lightDevices).limit(1).get();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "light";

function uniqueId(base: string): string {
  let id = slug(base);
  for (let i = 2; db.select({ id: lightDevices.id }).from(lightDevices).where(eq(lightDevices.id, id)).get(); i++) id = `${slug(base)}_${i}`;
  return id;
}

const fingerprintOf = (d: Pick<DeviceInput, "transport" | "address" | "fingerprint">) =>
  d.fingerprint ?? (d.transport === "ble" ? d.address.toUpperCase() : `${d.transport}:${d.address}`);

/**
 * Insert or update by fingerprint (MAC / entity id). Devices whose capabilities say
 * `segments` get one whole-strip segment on creation so the UI always has one to edit.
 */
export function upsertDevice(input: DeviceInput | Record<string, unknown>): LightDevice {
  const d = deviceInputSchema.parse(input);
  const fingerprint = fingerprintOf(d);
  const existing = db.select().from(lightDevices).where(eq(lightDevices.fingerprint, fingerprint)).get();
  const values = {
    name: d.name,
    room: d.room,
    transport: d.transport,
    address: d.transport === "ble" ? d.address.toUpperCase() : d.address,
    protocol: d.protocol ?? null,
    haEntity: d.haEntity ?? null,
    capabilities: JSON.stringify(d.capabilities),
    calibration: JSON.stringify(d.calibration),
    ledCount: d.ledCount,
    discoveredVia: d.discoveredVia,
    enabled: d.enabled,
  };
  if (existing) {
    db.update(lightDevices).set(values).where(eq(lightDevices.id, existing.id)).run();
    return mustGet(existing.id);
  }
  const id = d.id && !get(d.id) ? d.id : uniqueId(d.id ?? d.name);
  db.transaction((tx) => {
    tx.insert(lightDevices).values({ id, fingerprint, createdAt: Date.now(), ...values }).run();
    if (d.capabilities.segments) {
      tx.insert(lightSegments).values({ id: `${id}-s0`, deviceId: id, ord: 0, name: "@segments.whole", ledCount: d.ledCount, reverse: false, calibration: "{}" }).run();
    }
  });
  return mustGet(id);
}

export function updateDevice(id: string, patch: DevicePatch): LightDevice {
  const cur = mustGet(id);
  const set: Partial<typeof lightDevices.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.room !== undefined) set.room = patch.room;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.calibration !== undefined) set.calibration = JSON.stringify(patch.calibration);
  if (patch.haEntity !== undefined) set.haEntity = patch.haEntity;
  if (patch.capabilities !== undefined) set.capabilities = JSON.stringify({ ...cur.capabilities, ...patch.capabilities });
  if (patch.ledCount !== undefined) {
    set.ledCount = patch.ledCount;
    // One segment = the whole strip: keep it in step so led_count stays the sum.
    const only = cur.segments.length === 1 ? cur.segments[0] : undefined;
    if (only) db.update(lightSegments).set({ ledCount: patch.ledCount }).where(eq(lightSegments.id, only.id)).run();
  }
  if (Object.keys(set).length) db.update(lightDevices).set(set).where(eq(lightDevices.id, id)).run();
  syncLedCount(id);
  return mustGet(id);
}

export function deleteDevice(id: string): void {
  mustGet(id);
  db.transaction((tx) => {
    tx.delete(lightGroupMembers).where(eq(lightGroupMembers.target, `dev:${id}`)).run();
    const segIds = tx.select({ id: lightSegments.id }).from(lightSegments).where(eq(lightSegments.deviceId, id)).all().map((s) => `seg:${s.id}`);
    if (segIds.length) tx.delete(lightGroupMembers).where(inArray(lightGroupMembers.target, segIds)).run();
    tx.delete(lightDevices).where(eq(lightDevices.id, id)).run();
  });
}

function syncLedCount(deviceId: string) {
  const segs = db.select({ n: lightSegments.ledCount }).from(lightSegments).where(eq(lightSegments.deviceId, deviceId)).all();
  if (segs.length) db.update(lightDevices).set({ ledCount: segs.reduce((a, s) => a + s.n, 0) }).where(eq(lightDevices.id, deviceId)).run();
}

export function recordHealth(id: string, h: { health: LightDevice["health"]; latencyMs?: number | null; error?: string | null; seen?: boolean }) {
  const set: Partial<typeof lightDevices.$inferInsert> = { health: h.health, lastError: h.error ?? null };
  if (h.latencyMs !== undefined) set.lastLatencyMs = h.latencyMs;
  if (h.seen) set.lastSeenAt = Date.now();
  db.update(lightDevices).set(set).where(eq(lightDevices.id, id)).run();
}

// --- segments ---------------------------------------------------------------

export function getSegment(id: string): { device: LightDevice; segment: Segment } {
  const row = db.select().from(lightSegments).where(eq(lightSegments.id, id)).get();
  if (!row) throw new LightError("segmentNotFound", { id });
  const device = mustGet(row.deviceId);
  const segment = device.segments.find((s) => s.id === id);
  if (!segment) throw new LightError("segmentNotFound", { id });
  return { device, segment };
}

export function addSegment(deviceId: string, input: { name: string; ledCount: number }): Segment {
  const dev = mustGet(deviceId);
  const id = `${deviceId}-${randomUUID().slice(0, 8)}`;
  const next = appendSegment(dev.segments, { ...input, id, deviceId });
  const seg = next[next.length - 1];
  if (!seg) throw new LightError("invalid");
  db.transaction((tx) => {
    tx.insert(lightSegments).values({ id, deviceId, ord: seg.ord, name: seg.name, ledCount: seg.ledCount, reverse: false, calibration: "{}" }).run();
    if (!dev.capabilities.segments) tx.update(lightDevices).set({ capabilities: JSON.stringify({ ...dev.capabilities, segments: true }) }).where(eq(lightDevices.id, deviceId)).run();
  });
  syncLedCount(deviceId);
  return seg;
}

export function updateSegment(id: string, patch: SegmentPatch): Segment {
  const { device } = getSegment(id);
  const set: Partial<typeof lightSegments.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.ledCount !== undefined) set.ledCount = patch.ledCount;
  if (patch.reverse !== undefined) set.reverse = patch.reverse;
  if (patch.calibration !== undefined) set.calibration = JSON.stringify(patch.calibration);
  if (Object.keys(set).length) db.update(lightSegments).set(set).where(eq(lightSegments.id, id)).run();
  syncLedCount(device.id);
  return getSegment(id).segment;
}

export function deleteSegment(id: string): void {
  const { device } = getSegment(id);
  if (device.segments.length <= 1) throw new LightError("lastSegment");
  db.transaction((tx) => {
    tx.delete(lightGroupMembers).where(eq(lightGroupMembers.target, `seg:${id}`)).run();
    tx.delete(lightSegments).where(eq(lightSegments.id, id)).run();
  });
  syncLedCount(device.id);
}

/** New order = the given segment ids; ords are rewritten 0..n-1 (via negatives to dodge UNIQUE). */
export function reorder(deviceId: string, segmentIds: string[]): Segment[] {
  const dev = mustGet(deviceId);
  const known = new Set(dev.segments.map((s) => s.id));
  if (segmentIds.length !== known.size || !segmentIds.every((s) => known.has(s))) throw new LightError("invalid");
  db.transaction((tx) => {
    segmentIds.forEach((id, i) => tx.update(lightSegments).set({ ord: -1 - i }).where(eq(lightSegments.id, id)).run());
    segmentIds.forEach((id, i) => tx.update(lightSegments).set({ ord: i }).where(eq(lightSegments.id, id)).run());
  });
  return mustGet(deviceId).segments;
}

// --- groups -----------------------------------------------------------------

export type LightGroup = { id: string; name: string; kind: string; members: string[] };

export function listGroups(): LightGroup[] {
  const members = db.select().from(lightGroupMembers).all();
  return db
    .select()
    .from(lightGroups)
    .orderBy(asc(lightGroups.name))
    .all()
    .map((g) => ({ ...g, members: members.filter((m) => m.groupId === g.id).map((m) => m.target) }));
}

export function getGroup(id: string): LightGroup {
  const g = listGroups().find((x) => x.id === id);
  if (!g) throw new LightError("groupNotFound", { id });
  return g;
}

export function saveGroup(input: { id?: string | undefined; name: string; kind?: string; members: string[] }): LightGroup {
  const id = input.id ?? `grp_${randomUUID().slice(0, 8)}`;
  db.transaction((tx) => {
    tx.insert(lightGroups)
      .values({ id, name: input.name, kind: input.kind ?? "custom" })
      .onConflictDoUpdate({ target: lightGroups.id, set: { name: input.name, ...(input.kind ? { kind: input.kind } : {}) } })
      .run();
    tx.delete(lightGroupMembers).where(eq(lightGroupMembers.groupId, id)).run();
    for (const target of new Set(input.members)) tx.insert(lightGroupMembers).values({ groupId: id, target }).run();
  });
  return getGroup(id);
}

export function deleteGroup(id: string): void {
  getGroup(id);
  db.transaction((tx) => {
    tx.delete(lightGroupMembers).where(eq(lightGroupMembers.groupId, id)).run();
    tx.delete(lightGroups).where(eq(lightGroups.id, id)).run();
  });
}

// --- scenes -----------------------------------------------------------------

export type SceneEntry = { target: string; state: LightState };
export type LightScene = { id: string; name: string; entries: SceneEntry[]; createdAt: number };

export function listScenes(): LightScene[] {
  return db
    .select()
    .from(lightScenes)
    .orderBy(asc(lightScenes.name))
    .all()
    .map((s) => ({ id: s.id, name: s.name, entries: parseJson<SceneEntry[]>(s.entries, []), createdAt: s.createdAt }));
}

export function getScene(id: string): LightScene {
  const s = listScenes().find((x) => x.id === id);
  if (!s) throw new LightError("sceneNotFound", { id });
  return s;
}

export function saveScene(name: string, entries: SceneEntry[], id?: string): LightScene {
  const sceneId = id ?? `scn_${randomUUID().slice(0, 8)}`;
  db.insert(lightScenes)
    .values({ id: sceneId, name, entries: JSON.stringify(entries), createdAt: Date.now() })
    .onConflictDoUpdate({ target: lightScenes.id, set: { name, entries: JSON.stringify(entries) } })
    .run();
  return getScene(sceneId);
}

export function deleteScene(id: string): void {
  getScene(id);
  db.delete(lightScenes).where(eq(lightScenes.id, id)).run();
}

// --- profiles ---------------------------------------------------------------

export type LightProfile = { id: string; name: string; calibration: Calibration; active: boolean };

const DEFAULT_PROFILES: LightProfile[] = [
  { id: "day", name: "@profiles.day", calibration: {}, active: true },
  { id: "night", name: "@profiles.night", calibration: { briCap: 0.4, gains: [1, 0.85, 0.6], kelvinOffset: -500 }, active: false },
];

export function seedProfiles(): void {
  for (const p of DEFAULT_PROFILES) {
    db.insert(lightProfiles).values({ ...p, calibration: JSON.stringify(p.calibration) }).onConflictDoNothing().run();
  }
}

export function listProfiles(): LightProfile[] {
  seedProfiles();
  return db
    .select()
    .from(lightProfiles)
    .orderBy(asc(lightProfiles.id))
    .all()
    .map((p) => ({ id: p.id, name: p.name, calibration: parseCal(p.calibration), active: p.active }));
}

export function activeProfile(): LightProfile | null {
  return listProfiles().find((p) => p.active) ?? null;
}

export function activateProfile(id: string): LightProfile {
  if (!listProfiles().some((p) => p.id === id)) throw new LightError("profileNotFound", { id });
  db.transaction((tx) => {
    tx.update(lightProfiles).set({ active: false }).run();
    tx.update(lightProfiles).set({ active: true }).where(eq(lightProfiles.id, id)).run();
  });
  return listProfiles().find((p) => p.id === id)!;
}

export function updateProfile(id: string, calibration: Calibration): LightProfile {
  if (!listProfiles().some((p) => p.id === id)) throw new LightError("profileNotFound", { id });
  db.update(lightProfiles).set({ calibration: JSON.stringify(calibration) }).where(eq(lightProfiles.id, id)).run();
  return listProfiles().find((p) => p.id === id)!;
}

// --- target resolution ------------------------------------------------------

export type ResolvedTarget = { device: LightDevice; segment?: Segment };

/** Expand a target into (device, segment?) pairs; disabled devices are skipped. */
export function resolveTarget(target: string, seen = new Set<string>()): ResolvedTarget[] {
  if (seen.has(target)) return [];
  seen.add(target);
  const all = list().filter((d) => d.enabled);
  if (target === "all") return all.map((device) => ({ device }));
  const [kind, ...rest] = target.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "dev": {
      const device = all.find((d) => d.id === id);
      return device ? [{ device }] : [];
    }
    case "seg": {
      for (const device of all) {
        const segment = device.segments.find((s) => s.id === id);
        if (segment) return [{ device, segment }];
      }
      return [];
    }
    case "room":
      return all.filter((d) => d.room === id).map((device) => ({ device }));
    case "group":
      return getGroup(id).members.flatMap((m) => resolveTarget(m, seen));
    default:
      throw new LightError("unknownTarget", { target });
  }
}

// --- seeding ----------------------------------------------------------------

const RGB_MODES = new Set(["rgb", "hs", "xy", "rgbw", "rgbww"]);
const SKIP_ENTITIES = new Set(["light.hyperhdr"]);

export const MELK_OA10: DeviceInput = deviceInputSchema.parse({
  id: "melk_oa10",
  name: "MELK-OA10",
  room: "bedroom",
  transport: "ble",
  address: "BE:69:83:00:C4:0B",
  protocol: "melk",
  haEntity: "light.led_argb",
  capabilities: { onoff: true, brightness: true, rgb: true, kelvin: null, effects: [], addressable: false, segments: true, ledCountConfig: true, whiteOnly: false },
  ledCount: 1,
  fingerprint: "BE:69:83:00:C4:0B",
  discoveredVia: "seed",
});

export function capsFromHa(s: HaState, whiteOnly: boolean): Capabilities {
  const a = s.attributes;
  const modes = Array.isArray(a.supported_color_modes) ? (a.supported_color_modes as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
  const kelvin: [number, number] | null = modes.includes("color_temp") ? [num(a.min_color_temp_kelvin, 2000), num(a.max_color_temp_kelvin, 6500)] : null;
  const effects = Array.isArray(a.effect_list) ? (a.effect_list as unknown[]).filter((e): e is string => typeof e === "string").slice(0, 200) : [];
  return {
    onoff: true,
    brightness: modes.length > 0 && modes.some((m) => m !== "onoff"),
    rgb: !whiteOnly && modes.some((m) => RGB_MODES.has(m)),
    kelvin: kelvin ?? (whiteOnly ? [2700, 6500] : null),
    effects,
    addressable: false,
    segments: false,
    ledCountConfig: false,
    whiteOnly,
  };
}

/**
 * Add every HA light not yet in the registry (and not an alias of a PC-owned light),
 * plus the MELK-OA10 BLE strip. Idempotent: fingerprints are unique.
 */
export async function seedFromHa(states?: HaState[]): Promise<{ added: string[] }> {
  seedProfiles();
  const added: string[] = [];
  if (!db.select({ id: lightDevices.id }).from(lightDevices).where(eq(lightDevices.fingerprint, MELK_OA10.fingerprint!)).get()) {
    added.push(upsertDevice(MELK_OA10).id);
  }
  const all = states ?? (await ha.states());
  const rows = db.select({ fp: lightDevices.fingerprint, alias: lightDevices.haEntity, address: lightDevices.address, transport: lightDevices.transport }).from(lightDevices).all();
  const taken = new Set<string>();
  for (const r of rows) {
    if (r.alias) taken.add(r.alias);
    if (r.transport === "ha") taken.add(r.address);
  }
  for (const s of all) {
    if (!s.entity_id.startsWith("light.") || SKIP_ENTITIES.has(s.entity_id) || taken.has(s.entity_id)) continue;
    const cat = DEVICES.find((d) => d.entity === s.entity_id);
    const friendly = typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id;
    const dev = upsertDevice({
      id: slug(s.entity_id.slice("light.".length)),
      name: cat?.name ?? friendly,
      room: cat?.room ?? "bedroom",
      transport: "ha",
      address: s.entity_id,
      capabilities: capsFromHa(s, cat?.whiteOnly ?? false),
      fingerprint: `ha:${s.entity_id}`,
      discoveredVia: "ha",
    });
    added.push(dev.id);
  }
  return { added };
}

// --- export / import --------------------------------------------------------

export function exportJson(): RegistryExport {
  const devices = db.select().from(lightDevices).all();
  const segs = db.select().from(lightSegments).all();
  return {
    version: 1,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      room: d.room,
      transport: d.transport,
      address: d.address,
      protocol: d.protocol,
      haEntity: d.haEntity,
      capabilities: capabilitiesSchema.parse(parseJson(d.capabilities, {})),
      calibration: parseCal(d.calibration),
      ledCount: d.ledCount,
      fingerprint: d.fingerprint,
      discoveredVia: (["ha", "ble_scan", "manual", "seed"].includes(d.discoveredVia ?? "") ? d.discoveredVia : "manual") as DeviceInput["discoveredVia"],
      enabled: d.enabled,
      segments: segs
        .filter((s) => s.deviceId === d.id)
        .sort((a, b) => a.ord - b.ord)
        .map((s) => ({ id: s.id, ord: s.ord, name: s.name, ledCount: s.ledCount, reverse: s.reverse, calibration: parseCal(s.calibration) })),
    })),
    groups: listGroups(),
    scenes: listScenes().map(({ id, name, entries }) => ({ id, name, entries })),
    profiles: listProfiles(),
  };
}

/** Merge an export into the registry: devices by fingerprint, everything else by id. */
export function importJson(json: unknown): { devices: number; groups: number; scenes: number; profiles: number } {
  const data = registryExportSchema.parse(typeof json === "string" ? JSON.parse(json) : json);
  for (const { segments, ...d } of data.devices) {
    const dev = upsertDevice(d);
    if (!segments.length) continue;
    db.transaction((tx) => {
      tx.delete(lightSegments).where(eq(lightSegments.deviceId, dev.id)).run();
      segments
        .sort((a, b) => a.ord - b.ord)
        .forEach((s, i) =>
          tx.insert(lightSegments).values({ id: `${dev.id}-${s.id.split("-").pop() ?? i}-${i}`, deviceId: dev.id, ord: i, name: s.name, ledCount: s.ledCount, reverse: s.reverse, calibration: JSON.stringify(s.calibration) }).run(),
        );
    });
    syncLedCount(dev.id);
  }
  for (const g of data.groups) saveGroup(g);
  for (const s of data.scenes) saveScene(s.name, s.entries as SceneEntry[], s.id);
  for (const p of data.profiles) {
    db.insert(lightProfiles)
      .values({ id: p.id, name: p.name, calibration: JSON.stringify(p.calibration), active: false })
      .onConflictDoUpdate({ target: lightProfiles.id, set: { name: p.name, calibration: JSON.stringify(p.calibration) } })
      .run();
  }
  const act = data.profiles.find((p) => p.active);
  if (act) activateProfile(act.id);
  return { devices: data.devices.length, groups: data.groups.length, scenes: data.scenes.length, profiles: data.profiles.length };
}
