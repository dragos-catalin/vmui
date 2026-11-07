import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P9-01: the installed desktop app gets what it used to read from the repo's credentials.env
// from the hub, behind its own paired-device token, and only the owner's PC gets the broker login.

vi.mock("@/lib/auth", () => ({ authEnabled: async () => true, getCurrentUser: async () => null }));
const calls: Array<[string, string, Record<string, unknown>]> = [];
vi.mock("@/lib/home/ha-client", () => ({
  ha: {
    state: async () => ({ entity_id: "sun.sun", state: "above_horizon", attributes: {} }),
    callService: async (d: string, s: string, data: Record<string, unknown>) => {
      calls.push([d, s, data]);
      return [];
    },
  },
}));

let R: typeof import("./route");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token: string, init: RequestInit = {}) =>
  new Request("http://hub/api/desktop/agent", { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-agent-")), "t.db");
  process.env.MQTT_USER = "pc-user";
  process.env.MQTT_PASS = "pc-pass-0123";
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  const { db } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const now = new Date();
  const user = (id: string, role: "admin" | "viewer") => ({ id, email: `${id}@x.ro`, displayName: id, passwordHash: "x", role, createdAt: now });
  await db.insert(s.users).values([user("owner", "admin"), user("kid", "viewer"), user("guest", "viewer")]);
  await db.insert(s.homeMembers).values([
    { userId: "owner", role: "owner", rooms: "{}", createdAt: now },
    { userId: "kid", role: "child", rooms: JSON.stringify({ bedroom: "control" }), createdAt: now },
    { userId: "guest", role: "guest", rooms: JSON.stringify({ bedroom: "view" }), createdAt: now },
  ] as never);
  const dev = (id: string, token: string, userId: string | null) => ({ id, name: id, platform: "windows", tokenHash: sha(token), status: "approved", userId, createdAt: now });
  await db.insert(s.pairedDevices).values([dev("d-owner", "vmd_owner", "owner"), dev("d-kid", "vmd_kid", "kid"), dev("d-guest", "vmd_guest", "guest")] as never);
  R = await import("./route");
});

beforeEach(() => {
  calls.length = 0;
});

describe("GET /api/desktop/agent", () => {
  it("gives the owner's PC the broker login", async () => {
    const r = await R.GET(req("vmd_owner") as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { owner: boolean; haOnline: boolean; mqtt: { user: string; pass: string; port: number } | null };
    expect(j.owner).toBe(true);
    expect(j.haOnline).toBe(true);
    expect(j.mqtt).toMatchObject({ user: "pc-user", pass: "pc-pass-0123", port: 1883 });
  });

  it("never hands a family member's desktop the broker login", async () => {
    const r = await R.GET(req("vmd_kid") as never);
    const j = (await r.json()) as { owner: boolean; mqtt: unknown };
    expect(j.owner).toBe(false);
    expect(j.mqtt).toBeNull();
  });

  it("refuses an unknown token", async () => {
    const r = await R.GET(req("vmd_nobody") as never);
    expect(r.status).toBe(403);
  });
});

describe("POST /api/desktop/agent", () => {
  it("starts an allowed house script without waiting for it", async () => {
    const r = await R.POST(req("vmd_kid", { method: "POST", body: JSON.stringify({ script: "stream_scene_party" }) }) as never);
    expect(r.status).toBe(200);
    expect(calls).toEqual([["script", "turn_on", { entity_id: "script.stream_scene_party" }]]);
  });

  it("passes variables through", async () => {
    await R.POST(req("vmd_owner", { method: "POST", body: JSON.stringify({ script: "notify_flash", variables: { color: [255, 140, 0], duration_ms: 1500 } }) }) as never);
    expect(calls[0]?.[2]).toEqual({ entity_id: "script.notify_flash", variables: { color: [255, 140, 0], duration_ms: 1500 } });
  });

  it("rejects a script outside the list", async () => {
    const r = await R.POST(req("vmd_owner", { method: "POST", body: JSON.stringify({ script: "rm_rf" }) }) as never);
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses a view-only member", async () => {
    const r = await R.POST(req("vmd_guest", { method: "POST", body: JSON.stringify({ script: "movie_mode_on" }) }) as never);
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
