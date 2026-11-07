import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// /api/v1/app (P3-01): header-only device auth, family-model permissions per operation,
// output validated against the declared schema.

const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
const events: Array<{ type: string; data: Record<string, unknown> }> = [];
vi.mock("@/lib/auth", () => ({ authEnabled: async () => true, getCurrentUser: async () => null }));
vi.mock("@/lib/home/ha-client", () => ({
  ha: {
    states: async () => [{ entity_id: "light.kid_lamp", state: "on", attributes: { brightness: 200 }, last_changed: "", last_updated: "" }],
    callService: async (domain: string, service: string, data: Record<string, unknown>) => void calls.push({ domain, service, data }),
    runScript: async () => undefined,
    fireEvent: async (type: string, data: Record<string, unknown>) => void events.push({ type, data }),
  },
}));
const cards: Record<string, Record<string, unknown>> = {
  "c-pc": { id: "c-pc", kind: "pc", title: "PC offline", body: "", subtitle: null, priority: "default", url: null, actions: [], createdAt: 1, readAt: null },
  "c-door": { id: "c-door", kind: "intercom", title: "Door", body: "", subtitle: null, priority: "high", url: null, actions: [{ id: "open", label: "Open", style: "primary" }], createdAt: 2, readAt: null },
};
vi.mock("@/lib/notify", () => ({
  notify: async () => null,
  dismissByTag: async () => undefined,
  listCards: async () => [],
  localizeCards: async () => [],
  localizeCard: async (c: unknown) => c,
  markRead: async () => undefined,
  ack: async () => undefined,
  dismiss: async () => null,
  getCard: async (id: string) => cards[id] ?? null,
  visibleToRole: (kind: string, role: string) => role === "owner" || kind === "intercom",
}));
vi.mock("@/lib/cloud/identity", () => ({ cloudEndpoints: () => ({ api: "https://push.vatra.test" }), hubIdentity: () => ({ hubId: "abcdefghijklmnop", pub: "x" }) }));

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

describe("push registration (P7-03)", () => {
  const P256 = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
  const row = async (id: string) => {
    const { db } = await import("@/lib/db");
    const s = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    return db.select().from(s.pairedDevices).where(eq(s.pairedDevices.id, id)).get();
  };

  it("stores a UnifiedPush endpoint with its keys on the calling device only", async () => {
    const r = await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "unifiedpush", endpoint: "https://ntfy.sh/upKid?up=1", p256dh: P256, auth: "tBHItJI5svbpez7KI4CCXg" } });
    expect(r.body).toEqual({ ok: true });
    expect(await row("d-kid")).toMatchObject({ pushKind: "unifiedpush", pushToken: "https://ntfy.sh/upKid?up=1", pushP256dh: P256 });
    expect((await row("d-owner"))?.pushToken ?? null).toBeNull();
  });

  it("refuses endpoints inside the house network", async () => {
    for (const endpoint of ["http://ntfy.sh/x", "https://192.168.1.10/up", "https://homeassistant.local/up", "https://10.0.0.2/up"]) {
      const r = await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "unifiedpush", endpoint, p256dh: P256, auth: "tBHItJI5svbpez7KI4CCXg" } });
      expect(r.status, endpoint).toBe(400);
    }
    expect((await row("d-kid"))?.pushToken).toBe("https://ntfy.sh/upKid?up=1");
  });

  it("switching to FCM clears the Web Push keys, none clears everything", async () => {
    await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "fcm", token: "f".repeat(40) } });
    expect(await row("d-kid")).toMatchObject({ pushKind: "fcm", pushToken: "f".repeat(40), pushP256dh: null, pushAuth: null });
    await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "none" } });
    expect(await row("d-kid")).toMatchObject({ pushKind: null, pushToken: null });
  });

  it("stores an iOS APNs token (lower-cased) with its sandbox flag and Live Activity token (P8-02)", async () => {
    const r = await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "apns", token: "AB".repeat(32), sandbox: true, activityToken: "cd".repeat(32) } });
    expect(r.body).toEqual({ ok: true });
    expect(await row("d-kid")).toMatchObject({ pushKind: "apns-sandbox", pushToken: "ab".repeat(32), pushActivity: "cd".repeat(32), pushP256dh: null });
    await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "apns", token: "ef".repeat(32) } });
    expect(await row("d-kid")).toMatchObject({ pushKind: "apns", pushToken: "ef".repeat(32), pushActivity: null });
    for (const token of ["zz".repeat(32), "ab".repeat(10)]) {
      expect((await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "apns", token } })).status, token).toBe(400);
    }
    await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "none" } });
    expect(await row("d-kid")).toMatchObject({ pushKind: null, pushToken: null, pushActivity: null });
  });

  it("config always offers Web Push and hides FCM when the hub has no Firebase app", async () => {
    const r = await call(R.pushConfigRoute, "vmd_guest");
    expect(r.body).toMatchObject({ webPush: true, apns: false, relay: null });
    expect(r.body.fcm === null || typeof r.body.fcm === "object").toBe(true);
  });

  it("config offers the Vatra Cloud relay once the owner enabled it", async () => {
    process.env.VATRA_CLOUD_PUSH = "1";
    try {
      expect((await call(R.pushConfigRoute, "vmd_guest")).body).toMatchObject({ relay: { url: "https://push.vatra.test", hub: "abcdefghijklmnop" } });
    } finally {
      delete process.env.VATRA_CLOUD_PUSH;
    }
  });

  it("relay registration returns a fresh e2e key once and stores it encrypted; any other kind clears it", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const handle = `h1.${"A".repeat(30)}_-x`;
    const act = `h1.${"b".repeat(40)}`;
    const r = await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "relay", platform: "apns-sandbox", handle, activityHandle: act } });
    expect(r.status).toBe(200);
    const key = r.body.e2eKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    const stored = await row("d-kid");
    expect(stored).toMatchObject({ pushKind: "relay-apns-sandbox", pushToken: handle, pushActivity: act });
    expect(stored?.pushKey).toBeTruthy();
    expect(stored?.pushKey).not.toBe(key);
    expect(stored?.pushKey).not.toContain(key);
    expect(decrypt(stored!.pushKey!)).toBe(key);
    const again = await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "relay", platform: "fcm", handle } });
    expect(again.body.e2eKey).not.toBe(key);
    expect(await row("d-kid")).toMatchObject({ pushKind: "relay-fcm", pushActivity: null });
    for (const bad of ["h2.aaaaaaaaaaaaaaaaaaaaaaaa", "h1.short", `h1.${"a".repeat(30)}=`]) {
      expect((await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "relay", platform: "fcm", handle: bad } })).status, bad).toBe(400);
    }
    expect((await call(R.pushRegisterRoute, "vmd_kid", { body: { kind: "fcm", token: "f".repeat(40) } })).body).toEqual({ ok: true });
    expect(await row("d-kid")).toMatchObject({ pushKind: "fcm", pushKey: null });
  });
});

describe("push card (P10)", () => {
  it("returns a card the member may see, in the notify list shape", async () => {
    const r = await call(R.pushCardRoute, "vmd_guest", { query: "id=c-door" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "c-door", kind: "intercom", title: "Door", actions: [{ id: "open", label: "Open", style: "primary" }] });
    expect((await call(R.pushCardRoute, "vmd_owner", { query: "id=c-pc" })).body).toMatchObject({ id: "c-pc" });
  });

  it("refuses an owner-only card to a guest and a missing card with not_found", async () => {
    const g = await call(R.pushCardRoute, "vmd_guest", { query: "id=c-pc" });
    expect(g.status).toBe(404);
    expect(g.body).toMatchObject({ ok: false, code: "not_found" });
    expect((await call(R.pushCardRoute, "vmd_owner", { query: "id=nope" })).status).toBe(404);
  });
});

describe("presence (P7-05)", () => {
  it("fires vatra_presence once per state change, as the calling member", async () => {
    events.length = 0;
    expect((await call(R.presenceRoute, "vmd_kid", { body: { state: "home" } })).body).toEqual({ ok: true, fired: true });
    expect((await call(R.presenceRoute, "vmd_kid", { body: { state: "home", source: "nfc" } })).body).toEqual({ ok: true, fired: false });
    expect((await call(R.presenceRoute, "vmd_kid", { body: { state: "away" } })).body).toEqual({ ok: true, fired: true });
    expect(events).toEqual([
      { type: "vatra_presence", data: { user: "kid", member: "kid", state: "home", source: "geofence" } },
      { type: "vatra_presence", data: { user: "kid", member: "kid", state: "away", source: "geofence" } },
    ]);
  });

  it("rejects unknown states", async () => {
    expect((await call(R.presenceRoute, "vmd_kid", { body: { state: "everywhere" } })).status).toBe(400);
  });
});
