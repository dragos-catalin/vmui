import "server-only";

import type { CatalogDevice, DeviceKind } from "./catalog";
import { haWsCommands, type HaState } from "./ha-client";
import { house, upsertDevice, upsertRoom } from "./house";

// Build the house from Home Assistant: every HA area becomes a room, every HA
// device with a supported entity becomes a device in its area. Idempotent:
// existing rooms/devices keep their ids, positions and names the user edited;
// only new ones are added. Used by the setup wizard and Settings → House.

type Area = { area_id: string; name: string };
type HaDevice = { id: string; name: string | null; name_by_user: string | null; area_id: string | null; manufacturer: string | null; model: string | null; entry_type?: string | null; disabled_by: string | null };
type HaEntity = { entity_id: string; device_id: string | null; area_id: string | null; disabled_by: string | null; hidden_by: string | null; entity_category: string | null };

/** HA domain -> our device kind, for the PRIMARY entity of a device. Order = priority. */
const PRIMARY: Array<[string, DeviceKind]> = [
  ["climate", "ac"],
  ["light", "light"],
  ["media_player", "tv"],
  ["cover", "sensor"],
  ["lock", "door"],
  ["fan", "sensor"],
  ["switch", "sensor"],
  ["binary_sensor", "sensor"],
  ["sensor", "sensor"],
];

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "room";

export type ImportPlan = { rooms: Array<{ id: string; name: string; haArea: string; isNew: boolean }>; devices: Array<{ id: string; name: string; room: string; entity: string; kind: DeviceKind; isNew: boolean }> };

/** Pure: compute what an import would add, given HA registries and the current house. */
export function planImport(areas: Area[], devices: HaDevice[], entities: HaEntity[], states: HaState[], current: { roomIds: Set<string>; deviceIds: Set<string>; entities: Set<string>; areaToRoom: Map<string, string> }): ImportPlan {
  const live = new Set(states.map((s) => s.entity_id));
  const rooms: ImportPlan["rooms"] = [];
  const areaRoom = new Map(current.areaToRoom);
  const taken = new Set(current.roomIds);
  for (const a of areas) {
    if (areaRoom.has(a.area_id)) continue;
    let id = slug(a.area_id || a.name);
    for (let i = 2; taken.has(id); i++) id = `${slug(a.area_id)}_${i}`;
    taken.add(id);
    areaRoom.set(a.area_id, id);
    rooms.push({ id, name: a.name, haArea: a.area_id, isNew: true });
  }
  const byDevice = new Map<string, HaEntity[]>();
  for (const e of entities) {
    if (!e.device_id || e.disabled_by || e.hidden_by || e.entity_category || !live.has(e.entity_id)) continue;
    byDevice.set(e.device_id, [...(byDevice.get(e.device_id) ?? []), e]);
  }
  const out: ImportPlan["devices"] = [];
  const takenDev = new Set(current.deviceIds);
  for (const d of devices) {
    if (d.disabled_by || d.entry_type === "service") continue;
    const ents = byDevice.get(d.id) ?? [];
    if (ents.some((e) => current.entities.has(e.entity_id))) continue; // already in the house
    let primary: HaEntity | undefined;
    let kind: DeviceKind = "sensor";
    for (const [domain, k] of PRIMARY) {
      primary = ents.find((e) => e.entity_id.startsWith(`${domain}.`));
      if (primary) { kind = k; break; }
    }
    if (!primary) continue;
    const area = primary.area_id ?? d.area_id;
    const room = area ? areaRoom.get(area) : undefined;
    if (!room) continue;
    let id = slug(d.name_by_user ?? d.name ?? primary.entity_id.split(".")[1] ?? d.id);
    for (let i = 2; takenDev.has(id); i++) id = `${slug(d.name_by_user ?? d.name ?? d.id)}_${i}`;
    takenDev.add(id);
    out.push({ id, name: d.name_by_user ?? d.name ?? primary.entity_id, room, entity: primary.entity_id, kind, isNew: true });
  }
  return { rooms, devices: out };
}

/** Read HA registries and apply the plan. Returns what was added. */
export async function importFromHomeAssistant(opts: { dryRun?: boolean } = {}): Promise<ImportPlan> {
  const [areas, devices, entities, states] = await haWsCommands<[Area[], HaDevice[], HaEntity[], HaState[]]>(["config/area_registry/list", "config/device_registry/list", "config/entity_registry/list", "get_states"]);
  const h = house();
  const current = {
    roomIds: new Set(h.rooms.map((r) => r.id)),
    deviceIds: new Set(h.devices.map((d) => d.id)),
    entities: new Set(h.devices.flatMap((d) => [d.entity, ...(d.entities ?? [])].filter((e): e is string => !!e))),
    areaToRoom: new Map<string, string>(),
  };
  const plan = planImport(areas, devices, entities, states, current);
  if (opts.dryRun) return plan;
  const n = h.rooms.length;
  plan.rooms.forEach((r, i) => {
    // lay new rooms out on a 2-column grid after the existing ones
    const k = n + i;
    upsertRoom({ id: r.id, name: r.name, haArea: r.haArea, x: (k % 2) * 50 + 2, y: Math.floor(k / 2) * 34 + 2, w: 46, h: 30, sort: k });
  });
  const perRoom = new Map<string, number>();
  for (const d of plan.devices) {
    const i = perRoom.get(d.room) ?? 0;
    perRoom.set(d.room, i + 1);
    const dev: CatalogDevice = { id: d.id, name: d.name, kind: d.kind, entity: d.entity, room: d.room, x: 15 + (i % 4) * 22, y: 25 + Math.floor(i / 4) * 25, via: "Home Assistant" };
    upsertDevice(dev);
  }
  return plan;
}
