import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ authEnabled: async () => true, getCurrentUser: async () => null }));
vi.mock("@/lib/household", () => ({ ownerPhoneSensor: (s: string) => `sensor.dragos_s_s25_ultra_${s}` }));
// the owner install's house = the catalog seed
vi.mock("@/lib/home/house", async () => {
  const c = await import("./catalog");
  return { houseRooms: () => c.ROOMS, houseDevices: () => c.DEVICES };
});

import { accessView, canControl, canControlAny, canOpenDoor, canView, parseGrants, roomOfEntity, visibleEntities, visibleRooms, type HomeActor } from "./access";

const actor = (over: Partial<HomeActor>): HomeActor => ({ userId: "u", email: "u@x", displayName: "U", role: "adult", rooms: {}, expiresAt: null, deviceId: null, ...over });

describe("room grants", () => {
  it("parses only known rooms and levels", () => {
    expect(parseGrants('{"bedroom":"control","kitchen":"view"}')).toEqual({ bedroom: "control", kitchen: "view" });
    expect(parseGrants('{"garage":"control"}')).toEqual({});
    expect(parseGrants('{"bedroom":"admin"}')).toEqual({});
    expect(parseGrants("not json")).toEqual({});
  });

  it("view lets you see but not control", () => {
    const a = actor({ rooms: { kitchen: "view", office: "control" } });
    expect(canView(a, "kitchen")).toBe(true);
    expect(canControl(a, "kitchen")).toBe(false);
    expect(canControl(a, "office")).toBe(true);
    expect(canView(a, "bedroom")).toBe(false);
    expect(visibleRooms(a)).toEqual(["kitchen", "office"]);
    expect(canControlAny(a)).toBe(true);
  });

  it("a view-only member cannot drive house-wide features", () => {
    const a = actor({ rooms: { living_room: "view" } });
    expect(canControlAny(a)).toBe(false);
    expect(visibleEntities(a).has("light.hyperhdr")).toBe(false);
  });
});

describe("visible entities follow the catalog rooms", () => {
  it("hides entities of rooms not granted", () => {
    const a = actor({ rooms: { kitchen: "control" } });
    const ents = visibleEntities(a);
    for (const e of ents) expect(roomOfEntity(e) === "kitchen" || e === "light.hyperhdr").toBe(true);
    expect(ents.has("sensor.dragos_s_s25_ultra_last_notification")).toBe(false);
  });
});

describe("roles", () => {
  it("only owner and adult open the door", () => {
    expect(canOpenDoor(actor({ role: "owner" }))).toBe(true);
    expect(canOpenDoor(actor({ role: "adult" }))).toBe(true);
    expect(canOpenDoor(actor({ role: "child" }))).toBe(false);
    expect(canOpenDoor(actor({ role: "guest" }))).toBe(false);
  });

  it("only the owner manages the home", () => {
    expect(accessView(actor({ role: "owner" })).canManage).toBe(true);
    expect(accessView(actor({ role: "adult" })).canManage).toBe(false);
  });
});
