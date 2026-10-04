import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60, scopes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), revoked_at INTEGER, last_used_at INTEGER, lookup_id TEXT
)`);
const db = drizzle(sqlite, { schema });

const verifyCalls = vi.fn();
vi.mock("@/lib/db", () => ({ db }));
// auth.ts pulls next/headers; the key format is all api-auth needs from it.
vi.mock("@/lib/auth", () => ({
  hashPassword: async (p: string) => {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${scryptSync(p, salt, 64).toString("hex")}`;
  },
  verifyPassword: async (p: string, stored: string) => {
    verifyCalls();
    const [, salt, key] = stored.split("$");
    const expected = Buffer.from(key!, "hex");
    const got = scryptSync(p, Buffer.from(salt!, "hex"), expected.length);
    return timingSafeEqual(got, expected);
  },
}));

const { apiKeyLookupId, generateApiKey, validateApiKey } = await import("./api-auth");

const req = (token: string) => new Request("http://x/api/mcp", { headers: { authorization: `Bearer ${token}` } });

async function insertKey(id: string, opts: { withLookup: boolean; revoked?: boolean; scopes?: string }) {
  const k = await generateApiKey();
  sqlite
    .prepare("INSERT INTO api_keys (id, name, hash, role, rate_limit_per_minute, scopes, lookup_id, revoked_at) VALUES (?, ?, ?, 'operator', 1000, ?, ?, ?)")
    .run(id, id, k.hash, opts.scopes ?? null, opts.withLookup ? k.lookupId : null, opts.revoked ? 1 : null);
  return k.plaintext;
}

const lookupOf = (id: string) => (sqlite.prepare("SELECT lookup_id FROM api_keys WHERE id = ?").get(id) as { lookup_id: string | null }).lookup_id;

beforeEach(() => {
  sqlite.exec("DELETE FROM api_keys");
  verifyCalls.mockClear();
});

describe("api key lookup", () => {
  it("lookup id is a stable 16-hex prefix and generateApiKey returns it", async () => {
    const k = await generateApiKey();
    expect(k.lookupId).toMatch(/^[0-9a-f]{16}$/);
    expect(apiKeyLookupId(k.plaintext)).toBe(k.lookupId);
  });

  it("verifies only the indexed row, not every key", async () => {
    for (let i = 0; i < 5; i++) await insertKey(`other-${i}`, { withLookup: true });
    const token = await insertKey("mine", { withLookup: true, scopes: '{"tools":["scene_set"]}' });
    const r = await validateApiKey(req(token));
    expect(r).toMatchObject({ ok: true, keyId: "mine", scopes: { tools: ["scene_set"] } });
    expect(verifyCalls).toHaveBeenCalledTimes(1);
  });

  it("falls back to scanning legacy keys and backfills the lookup id on first match", async () => {
    await insertKey("new", { withLookup: true });
    const token = await insertKey("legacy", { withLookup: false });
    expect(lookupOf("legacy")).toBeNull();
    expect(await validateApiKey(req(token))).toMatchObject({ ok: true, keyId: "legacy" });
    expect(lookupOf("legacy")).toBe(apiKeyLookupId(token));
    verifyCalls.mockClear();
    expect(await validateApiKey(req(token))).toMatchObject({ ok: true, keyId: "legacy" });
    expect(verifyCalls).toHaveBeenCalledTimes(1);
  });

  it("rejects revoked, unknown and missing tokens", async () => {
    const revoked = await insertKey("gone", { withLookup: true, revoked: true });
    expect(await validateApiKey(req(revoked))).toMatchObject({ ok: false, status: 401 });
    expect(await validateApiKey(req("vmui_nope"))).toMatchObject({ ok: false, status: 401 });
    expect(await validateApiKey(new Request("http://x"))).toMatchObject({ ok: false, status: 401 });
  });

  it("a token whose prefix collides with another row still needs its own hash", async () => {
    const token = await insertKey("real", { withLookup: true });
    const k = await generateApiKey();
    sqlite.prepare("INSERT INTO api_keys (id, name, hash, role, lookup_id) VALUES ('impostor', 'i', ?, 'operator', ?)").run(k.hash, apiKeyLookupId(token));
    expect(await validateApiKey(req(token))).toMatchObject({ ok: true, keyId: "real" });
  });
});
