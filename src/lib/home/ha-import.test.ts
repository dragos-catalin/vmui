import { describe, expect, it, vi } from "vitest";

vi.mock("./house", () => ({ house: () => ({ rooms: [], devices: [] }), upsertRoom: () => undefined, upsertDevice: () => undefined }));
vi.mock("./ha-client", () => ({ haWsCommands: async () => [] }));

import { planImport } from "./ha-import";

const st = (id: string) => ({ entity_id: id, state: "on", attributes: {}, last_changed: "", last_updated: "" });
const empty = () => ({ roomIds: new Set<string>(), deviceIds: new Set<string>(), entities: new Set<string>(), areaToRoom: new Map<string, string>() });

describe("planImport", () => {
  const areas = [{ area_id: "living_room", name: "Sufragerie" }, { area_id: "baie", name: "Baie" }];
  const devices = [
    { id: "d1", name: "Lampa", name_by_user: null, area_id: "living_room", manufacturer: null, model: null, disabled_by: null },
    { id: "d2", name: "AC", name_by_user: "AC dormitor", area_id: "baie", manufacturer: null, model: null, disabled_by: null },
    { id: "d3", name: "Sun", name_by_user: null, area_id: null, manufacturer: null, model: null, disabled_by: null, entry_type: "service" },
  ];
  const entities = [
    { entity_id: "light.lampa", device_id: "d1", area_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "sensor.lampa_power", device_id: "d1", area_id: null, disabled_by: null, hidden_by: null, entity_category: "diagnostic" },
    { entity_id: "climate.ac", device_id: "d2", area_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "sensor.ac_temp", device_id: "d2", area_id: null, disabled_by: null, hidden_by: null, entity_category: null },
  ];
  const states = ["light.lampa", "climate.ac", "sensor.ac_temp"].map(st);

  it("turns areas into rooms and picks the primary entity per device", () => {
    const p = planImport(areas, devices, entities, states, empty());
    expect(p.rooms.map((r) => r.id)).toEqual(["living_room", "baie"]);
    expect(p.devices).toEqual([
      expect.objectContaining({ id: "lampa", room: "living_room", entity: "light.lampa", kind: "light" }),
      expect.objectContaining({ id: "ac_dormitor", room: "baie", entity: "climate.ac", kind: "ac" }),
    ]);
  });

  it("is idempotent: devices whose entity is already in the house are skipped", () => {
    const cur = { ...empty(), roomIds: new Set(["living_room", "baie"]), areaToRoom: new Map([["living_room", "living_room"], ["baie", "baie"]]), entities: new Set(["light.lampa"]) };
    const p = planImport(areas, devices, entities, states, cur);
    expect(p.rooms).toEqual([]);
    expect(p.devices.map((d) => d.entity)).toEqual(["climate.ac"]);
  });

  it("never collides with existing room ids", () => {
    const cur = { ...empty(), roomIds: new Set(["living_room"]) };
    const p = planImport(areas, devices, entities, states, cur);
    expect(p.rooms[0]?.id).toBe("living_room_2");
  });
});
