import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ authEnabled: async () => false, getCurrentUser: async () => null }));

// The house is data: the owner install is seeded once from catalog.ts; a product
// install (VATRA_EMPTY_HOUSE=1) starts empty; rooms/devices added at runtime are
// visible to the access model without a rebuild.

async function fresh(empty: boolean) {
  vi.resetModules();
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-house-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  if (empty) process.env.VATRA_EMPTY_HOUSE = "1";
  else delete process.env.VATRA_EMPTY_HOUSE;
  const house = await import("./house");
  const access = await import("./access");
  return { house, access };
}

describe("house()", () => {
  it("owner install: seeded once from the catalog", async () => {
    const { house } = await fresh(false);
    const { ROOMS, DEVICES } = await import("./catalog");
    expect(house.houseRooms().map((r) => r.id)).toEqual(ROOMS.map((r) => r.id));
    expect(house.houseDevices()).toHaveLength(DEVICES.length);
    expect(house.houseEntities().has("light.desk_light_bar")).toBe(true);
  });

  it("product install: starts empty, no owner devices", async () => {
    const { house } = await fresh(true);
    expect(house.houseRooms()).toEqual([]);
    expect(house.houseEntities().size).toBe(0);
  });

  it("rooms and devices added at runtime drive access without a rebuild", async () => {
    const { house, access } = await fresh(true);
    house.upsertRoom({ id: "attic", name: "Attic", x: 0, y: 0, w: 50, h: 50 });
    house.upsertDevice({ id: "lamp", name: "Lamp", kind: "light", entity: "light.attic_lamp", room: "attic", x: 50, y: 50, via: "Zigbee" });
    expect(access.roomOfEntity("light.attic_lamp")).toBe("attic");
    const owner = (await access.currentHomeActor())!;
    expect(access.canControlEntity(owner, "light.attic_lamp")).toBe(true);
    expect(access.visibleEntities(owner).has("light.attic_lamp")).toBe(true);
    const guest = { ...owner, role: "guest" as const, rooms: {} };
    expect(access.canControlEntity(guest, "light.attic_lamp")).toBe(false);
  });

  it("refuses to delete a room that still has devices", async () => {
    const { house } = await fresh(true);
    house.upsertRoom({ id: "hall", name: "Hall", x: 0, y: 0, w: 50, h: 50 });
    house.upsertDevice({ id: "s", name: "Sensor", kind: "sensor", room: "hall", x: 1, y: 1, via: "" });
    expect(() => house.deleteRoom("hall")).toThrow("room_not_empty");
    house.deleteDevice("s");
    house.deleteRoom("hall");
    expect(house.houseRooms()).toEqual([]);
  });
});
