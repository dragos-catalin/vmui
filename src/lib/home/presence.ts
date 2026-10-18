import { DEVICES } from "./catalog";

type PresenceState = { entity_id: string; state: string; attributes: Record<string, unknown> };

const PRESENCE_CLASSES = new Set(["occupancy", "presence"]);

/** The desk presence sensor: the catalog's `presence` device when HA has it,
 *  otherwise the first `binary_sensor` HA classes as occupancy/presence, so a
 *  newly paired sensor gates the Turzx overlay before it is catalogued. */
export function presenceEntityId(states: Map<string, PresenceState>): string | null {
  for (const d of DEVICES) {
    if (d.kind === "presence" && d.entity && states.has(d.entity)) return d.entity;
  }
  const ids = [...states.keys()].filter((id) => id.startsWith("binary_sensor.")).sort();
  for (const id of ids) {
    const cls = states.get(id)?.attributes.device_class;
    if (typeof cls === "string" && PRESENCE_CLASSES.has(cls)) return id;
  }
  return null;
}
