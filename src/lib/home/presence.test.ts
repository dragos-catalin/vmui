import { describe, expect, it } from "vitest";
import { presenceEntityId } from "./presence";

const st = (entity_id: string, device_class?: string) => [entity_id, { entity_id, state: "on", attributes: device_class ? { device_class } : {} }] as const;

describe("presenceEntityId", () => {
  it("returns null when HA has no presence sensor", () => {
    expect(presenceEntityId(new Map([st("binary_sensor.main_door_door", "door"), st("binary_sensor.hall", "motion")]))).toBeNull();
  });

  it("finds an uncatalogued occupancy sensor by device_class", () => {
    expect(presenceEntityId(new Map([st("binary_sensor.main_door_door", "door"), st("binary_sensor.desk_mmwave_occupancy", "occupancy")]))).toBe("binary_sensor.desk_mmwave_occupancy");
  });

  it("ignores non-binary sensors with a presence class", () => {
    expect(presenceEntityId(new Map([st("sensor.weird", "presence")]))).toBeNull();
  });
});
