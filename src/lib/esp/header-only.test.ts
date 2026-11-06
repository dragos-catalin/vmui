import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// P0-06: tokens leave the URL. Headers everywhere; the Nest Hub gets a one-time code -> cookie
// valid on kiosk paths only; query tokens are audited and can be switched off.

vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined }));

let A: typeof import("./auth");
let K: typeof import("@/lib/display/kiosk-session");
let S: typeof import("@/app/api/display/session/route");
let hub = "";
let desk = "";

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-p006-")), "t.db");
  process.env.ESP_DISPLAY_TOKEN = "shared-legacy-token-0123456789ab";
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  const P = await import("@/lib/devices/pairing");
  hub = (await P.mintApplianceToken("nestHub", "Hub", "owner@home", null)).token;
  desk = (await P.mintApplianceToken("deskButton", "Desk", "owner@home", null)).token;
  A = await import("./auth");
  K = await import("@/lib/display/kiosk-session");
  S = await import("@/app/api/display/session/route");
});

afterEach(() => {
  delete process.env.VATRA_QUERY_TOKENS;
});

const req = (path: string, init: RequestInit = {}) => new Request(`http://hub${path}`, init);

describe("kiosk session", () => {
  it("swaps a one-time code for a cookie, once", async () => {
    const minted = await S.POST(req("/api/display/session", { method: "POST", headers: { authorization: `Bearer ${hub}` } }) as never);
    const { code, url } = (await minted.json()) as { code: string; url: string };
    expect(url).not.toContain(hub);
    const first = await S.GET(Object.assign(req(`/api/display/session?code=${code}&home=1`), { nextUrl: new URL(`http://hub/api/display/session?code=${code}&home=1`) }) as never);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("http://hub/display?home=1");
    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/vatra_kiosk=vmd_/);
    expect(cookie).toMatch(/HttpOnly/i);
    const again = await S.GET(Object.assign(req(`/api/display/session?code=${code}`), { nextUrl: new URL(`http://hub/api/display/session?code=${code}`) }) as never);
    expect(again.status).toBe(403);
  });

  it("refuses to mint a code for a token outside the kiosk scope", async () => {
    const r = await S.POST(req("/api/display/session", { method: "POST", headers: { authorization: `Bearer ${desk}` } }) as never);
    expect(r.status).toBe(403);
  });

  it("honours the cookie on kiosk paths only", () => {
    const cookie = { cookie: `vatra_kiosk=${encodeURIComponent(hub)}` };
    expect(A.espAuthorized(req("/api/display/state", { headers: cookie }))).toBe(true);
    expect(A.espAuthorized(req("/display", { headers: cookie }))).toBe(true);
    // a stolen kiosk cookie is not a general credential, even for the shared token
    const shared = { cookie: `vatra_kiosk=${process.env.ESP_DISPLAY_TOKEN}` };
    expect(A.espAuthorized(req("/api/pc/wake", { headers: shared }))).toBe(false);
  });

  it("expires codes", () => {
    vi.useFakeTimers();
    try {
      const code = K.mintKioskCode(hub);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(K.redeemKioskCode(code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("query-string tokens", () => {
  it("still work during the deprecation window and are audited", async () => {
    expect(A.espAuthorized(req(`/api/esp/button?d=${desk}`))).toBe(true);
    const { db } = await import("@/lib/db");
    const { auditLog } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = db.select().from(auditLog).where(eq(auditLog.action, "auth.query_token")).all();
    expect(rows.map((r) => r.target)).toContain("/api/esp/button");
    expect(JSON.stringify(rows)).not.toContain(desk);
  });

  it("are refused once VATRA_QUERY_TOKENS=0", () => {
    process.env.VATRA_QUERY_TOKENS = "0";
    expect(A.espAuthorized(req(`/api/esp/button?d=${desk}`))).toBe(false);
    expect(A.espAuthorized(req(`/api/esp/button?k=${process.env.ESP_DISPLAY_TOKEN}`))).toBe(false);
    expect(A.espAuthorized(req("/api/esp/button", { headers: { authorization: `Bearer ${desk}` } }))).toBe(true);
  });
});

describe("one-time links", () => {
  it("open exactly one path, once", async () => {
    const L = await import("@/app/api/devices/link/route");
    const r = await L.POST(req("/api/devices/link", { method: "POST", headers: { authorization: `Bearer ${hub}`, "content-type": "application/json" }, body: JSON.stringify({ path: "/display" }) }) as never);
    const { url } = (await r.json()) as { url: string };
    expect(url).toMatch(/^\/api\/display\/session\?code=/);
    const code = K.mintLinkCode(desk, "/api/esp/button");
    // wrong path: refused and burned
    expect(A.espAuthorized(req(`/api/nutrition/water?once=${code}`))).toBe(false);
    expect(A.espAuthorized(req(`/api/esp/button?once=${code}`))).toBe(false);
    const ok = K.mintLinkCode(desk, "/api/esp/button");
    const once = req(`/api/esp/button?once=${ok}`);
    expect(A.espAuthorized(once)).toBe(true);
    // the same request may ask again (actor lookups); a new request may not
    expect(A.deviceIdFromRequest(once)).not.toBeNull();
    expect(A.espAuthorized(req(`/api/esp/button?once=${ok}`))).toBe(false);
  });

  it("refuse a path outside the caller's scope", async () => {
    const L = await import("@/app/api/devices/link/route");
    const r = await L.POST(req("/api/devices/link", { method: "POST", headers: { authorization: `Bearer ${desk}`, "content-type": "application/json" }, body: JSON.stringify({ path: "/display" }) }) as never);
    expect(r.status).toBe(403);
  });
});
