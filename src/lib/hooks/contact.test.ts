import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimReplayKeys, handleContactHook, MAX_SKEW_SEC, preview, PREVIEW_CHARS, sign, type ContactHookDeps } from "./contact";

const SECRET = "test-secret-not-real";
const NOW_MS = Date.UTC(2026, 9, 5, 12, 0, 0);
const nowSec = () => Math.floor(NOW_MS / 1000);

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Ana", email: "ana@example.com", subject: "Hello", message: "Salut, am un proiect.", locale: "ro", receivedAt: "2026-10-05T12:00:00.000Z", ...over });

function request(raw: string, o: { ts?: number; sig?: string; nonce?: string; ip?: string } = {}): Request {
  const ts = String(o.ts ?? nowSec());
  return new Request("http://homepi/api/hooks/contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dc-timestamp": ts,
      "x-dc-signature": o.sig ?? sign(SECRET, ts, raw),
      "x-dc-nonce": o.nonce ?? randomUUID(),
      "x-forwarded-for": o.ip ?? "203.0.113.7",
    },
    body: raw,
  });
}

function sqliteClaim() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE contact_hook_nonces (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
  const d = drizzle(sqlite);
  return { sqlite, claim: (keys: string[], at: number) => claimReplayKeys(d, keys, at) };
}

let deliver: ReturnType<typeof vi.fn<ContactHookDeps["deliver"]>>;
let deps: ContactHookDeps;
let hits: Map<string, number>;

beforeEach(() => {
  deliver = vi.fn<ContactHookDeps["deliver"]>(async () => undefined);
  hits = new Map();
  const { claim } = sqliteClaim();
  deps = {
    secret: () => SECRET,
    nowMs: () => NOW_MS,
    limit: (src) => {
      const n = (hits.get(src) ?? 0) + 1;
      hits.set(src, n);
      return n <= 10;
    },
    claim,
    deliver,
  };
});

describe("POST /api/hooks/contact", () => {
  it("accepts a valid signature and delivers a 280-char preview", async () => {
    const long = "x".repeat(1000);
    const res = await handleContactHook(request(body({ message: long })), deps);
    expect(res.status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(1);
    const p = deliver.mock.calls[0]![0];
    expect(p.name).toBe("Ana");
    expect(Array.from(p.preview)).toHaveLength(PREVIEW_CHARS);
    expect(p.preview.endsWith("…")).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const raw = body();
    const res = await handleContactHook(request(raw, { sig: sign("wrong-secret", String(nowSec()), raw) }), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "bad_signature" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects a body tampered after signing", async () => {
    const raw = body();
    const ts = String(nowSec());
    const res = await handleContactHook(request(body({ name: "Mallory" }), { sig: sign(SECRET, ts, raw) }), deps);
    expect(res.status).toBe(401);
  });

  it("rejects missing signature headers", async () => {
    const req = new Request("http://homepi/api/hooks/contact", { method: "POST", body: body() });
    expect((await handleContactHook(req, deps)).status).toBe(401);
  });

  it("rejects a stale timestamp, even when correctly signed", async () => {
    const old = nowSec() - MAX_SKEW_SEC - 1;
    const res = await handleContactHook(request(body(), { ts: old }), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "stale_timestamp" });
    const future = nowSec() + MAX_SKEW_SEC + 1;
    expect((await handleContactHook(request(body(), { ts: future }), deps)).status).toBe(401);
  });

  it("rejects a replayed nonce", async () => {
    const nonce = randomUUID();
    expect((await handleContactHook(request(body(), { nonce }), deps)).status).toBe(202);
    const again = await handleContactHook(request(body({ message: "different" }), { nonce }), deps);
    expect(again.status).toBe(409);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed request re-sent with a fresh nonce (signature key)", async () => {
    const raw = body();
    const ts = String(nowSec());
    const sig = sign(SECRET, ts, raw);
    expect((await handleContactHook(request(raw, { sig }), deps)).status).toBe(202);
    expect((await handleContactHook(request(raw, { sig }), deps)).status).toBe(409);
  });

  it("rate-limits a source to 10 per minute", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await handleContactHook(request(body({ message: `m${i}` }), { ip: "198.51.100.9" }), deps)).status);
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await handleContactHook(request(body(), { ip: "198.51.100.10" }), deps)).status).toBe(202);
  });

  it("returns 503 when CONTACT_HOOK_SECRET is unset", async () => {
    const res = await handleContactHook(request(body()), { ...deps, secret: () => undefined });
    expect(res.status).toBe(503);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects an invalid body and a non-uuid nonce", async () => {
    const bad = await handleContactHook(request(body({ email: "not-an-email" })), deps);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_body", fields: ["email"] });
    expect((await handleContactHook(request(body(), { nonce: "abc" }), deps)).status).toBe(400);
  });

  it("never echoes the message body in error responses", async () => {
    const res = await handleContactHook(request(body({ message: "SECRET-CONTENT", email: "x" })), deps);
    expect(await res.text()).not.toContain("SECRET-CONTENT");
  });
});

describe("claimReplayKeys", () => {
  it("is all-or-nothing and forgets keys after the TTL", () => {
    const { sqlite, claim } = sqliteClaim();
    expect(claim(["n:a", "s:1"], 1000)).toBe(true);
    expect(claim(["n:b", "s:1"], 1001)).toBe(false);
    expect(sqlite.prepare("SELECT count(*) AS c FROM contact_hook_nonces WHERE key = 'n:b'").get()).toEqual({ c: 0 });
    expect(claim(["n:a", "s:2"], 1000 + 601)).toBe(true);
  });
});

describe("preview", () => {
  it("collapses whitespace and keeps short messages intact", () => {
    expect(preview("  a\n\n b  ")).toBe("a b");
  });
});
