import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// /api/v1/app (P3-01): header-only device auth, family-model permissions per operation,
// output validated against the declared schema.

const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
vi.mock("@/lib/auth", () => ({ authEnabled: async () => true, getCurrentUser: async () => null }));
vi.mock("@/lib/home/ha-client", () => ({
  ha: {
    states: async () => [{ entity_id: "light.kid_lamp", state: "on", attributes: { brightness: 200 }, last_changed: "", last_updated: "" }],
    callService: async (domain: string, service: string, data: Record<string, unknown>) => void calls.push({ domain, service, data }),
    runScript: async () => undefined,
  },
}));
vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined, listCards: async () => [], localizeCards: async () => [], localizeCard: async () => null, markRead: async () => undefined, ack: async () => undefined, dismiss: async () => null, getCard: async () => null, visibleToRole: () => true }));

let R: typeof import("./app-routes");
let H: typeof import("./define-route");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-v1-")), "t.db");
  process.env.VATRA_EMPTY_HOUSE = "1";
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  const { db } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const house = await import("@/lib/home/house");
  const now = new Date();
  house.upsertRoom({ id: "kids", name: "Kids", x: 0, y: 0, w: 1, h: 1 });
  house.upsertRoom({ id: "office", name: "Office", x: 1, y: 0, w: 1, h: 1 });
  await db.insert(s.homeDevices).values([
    { id: "kid-lamp", roomId: "kids", name: "Lamp", kind: "light", entity: "light.kid_lamp", entities: "[]", x: 0, y: 0, via: "ha" },
    { id: "office-lamp", roomId: "office", name: "Desk", kind: "light", entity: "light.office_lamp", entities: "[]", x: 0, y: 0, via: "ha" },
  ] as never);
  house.invalidateHouse();
  const user = (id: string, role: "admin" | "viewer") => ({ id, email: `${id}@x.ro`, displayName: id, passwordHash: "x", role, createdAt: now });
  await db.insert(s.users).values([user("owner", "admin"), user("kid", "viewer"), user("guest", "viewer")]);
  await db.insert(s.homeMembers).values([
    { userId: "owner", role: "owner", rooms: "{}", createdAt: now },
    { userId: "kid", role: "child", rooms: JSON.stringify({ kids: "control" }), createdAt: now },
    { userId: "guest", role: "guest", rooms: JSON.stringify({ kids: "view" }), createdAt: now },
  ] as never);
  const dev = (id: string, token: string, userId: string | null) => ({ id, name: id, platform: "android", tokenHash: sha(token), status: "approved", userId, createdAt: now });
  await db.insert(s.pairedDevices).values([dev("d-owner", "vmd_owner", "owner"), dev("d-kid", "vmd_kid", "kid"), dev("d-guest", "vmd_guest", "guest"), dev("d-free", "vmd_free", null)] as never);
  R = await import("./app-routes");
  H = await import("./define-route");
});

const call = async (route: Parameters<typeof H.handle>[0], token: string | null, init: { body?: unknown; query?: string; url?: string } = {}) => {
  const url = `http://hub${route.path}${init.query ? `?${init.query}` : ""}`;
  const headers: Record<string, string> = { "accept-language": "ro", "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await H.handle(route)(new Request(url, { method: route.method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("auth", () => {
  it("refuses a missing token with the localised error contract", async () => {
    const r = await call(R.meRoute, null);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("ignores a token in the query string", async () => {
    expect((await call(R.meRoute, null, { query: "d=vmd_owner" })).status).toBe(401);
  });

  it("refuses an unbound device", async () => {
    expect((await call(R.meRoute, "vmd_free")).body).toMatchObject({ code: "not_bound" });
  });
});

describe("family model", () => {
  it("me reports the member's rooms and abilities", async () => {
    const r = await call(R.meRoute, "vmd_kid");
    expect(r.body).toMatchObject({ member: { role: "child" }, rooms: { kids: "control" }, can: { openDoor: false, manageHome: false } });
  });

  it("state hides rooms and devices outside the grants", async () => {
    const r = await call(R.stateRoute, "vmd_kid");
    expect((r.body.rooms as Array<{ id: string }>).map((x) => x.id)).toEqual(["kids"]);
    expect((r.body.devices as Array<{ id: string }>).map((x) => x.id)).toEqual(["kid-lamp"]);
    expect(Object.keys(r.body.states as object)).toEqual(["light.kid_lamp"]);
  });

  it("a guest with view-only access cannot control the room it sees", async () => {
    const r = await call(R.controlRoute, "vmd_guest", { body: { type: "toggle", entity: "light.kid_lamp", on: false } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "no_room_access" });
  });

  it("a child controls its own room but not another", async () => {
    calls.length = 0;
    expect((await call(R.controlRoute, "vmd_kid", { body: { type: "toggle", entity: "light.kid_lamp", on: false } })).body).toEqual({ ok: true });
    expect(calls).toEqual([{ domain: "light", service: "turn_off", data: { entity_id: "light.kid_lamp" } }]);
    expect((await call(R.controlRoute, "vmd_kid", { body: { type: "toggle", entity: "light.office_lamp", on: true } })).status).toBe(403);
  });

  it("rejects an entity the house does not render", async () => {
    const r = await call(R.controlRoute, "vmd_owner", { body: { type: "toggle", entity: "switch.not_ours", on: true } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request" });
  });

  it("only owners and adults open the door", async () => {
    expect((await call(R.intercomActRoute, "vmd_kid", { body: { action: "open" } })).status).toBe(403);
    expect((await call(R.intercomActRoute, "vmd_kid", { body: { action: "ignore" } })).body).toMatchObject({ ok: true, canOpen: false });
  });
});
