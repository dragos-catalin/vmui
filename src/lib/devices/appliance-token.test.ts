import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { APPLIANCE_PROFILES, parseScopes, pathInScopes } from "./appliance-scopes";

// Appliance tokens (P3-03): a token minted for one piece of hardware only opens its own routes.

vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined }));

let P: typeof import("./pairing");
let A: typeof import("@/lib/esp/auth");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-app-")), "t.db");
  delete process.env.ESP_DISPLAY_TOKEN;
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  P = await import("./pairing");
  A = await import("@/lib/esp/auth");
});

const req = (path: string, token: string) => new Request(`http://hub${path}`, { headers: { authorization: `Bearer ${token}` } });

describe("scope matching", () => {
  it("matches whole segments, never a longer sibling", () => {
    expect(pathInScopes("/api/esp/button", ["/api/esp/button"])).toBe(true);
    expect(pathInScopes("/api/esp/button/long", ["/api/esp/button"])).toBe(true);
    expect(pathInScopes("/api/esp/buttonx", ["/api/esp/button"])).toBe(false);
    expect(pathInScopes("/api/esp/display/desk", ["/api/esp/display/"])).toBe(true);
  });

  it("fails closed on malformed stored scopes", () => {
    expect(parseScopes("{oops")).toEqual([]);
    expect(parseScopes('{"a":1}')).toEqual([]);
    expect(parseScopes(null)).toBeNull();
  });
});

describe("appliance tokens", () => {
  it("open only the profile routes", async () => {
    const { token } = await P.mintApplianceToken("deskButton", "Desk", "owner@home", null);
    expect(A.espAuthorized(req("/api/esp/button", token))).toBe(true);
    expect(A.espAuthorized(req("/api/nutrition/water", token))).toBe(true);
    expect(A.espAuthorized(req("/api/desktop/pc", token))).toBe(false);
    expect(A.espAuthorized(req("/api/lights", token))).toBe(false);
  });

  it("stop working once revoked", async () => {
    const { id, token } = await P.mintApplianceToken("esp32", "Hall ESP", "owner@home", null);
    expect(A.espAuthorized(req("/api/esp/display/hall", token))).toBe(true);
    await P.revokeDevice(id, "owner@home");
    expect(A.espAuthorized(req("/api/esp/display/hall", token))).toBe(false);
  });

  it("every profile route is a real token-gated API path", () => {
    for (const scopes of Object.values(APPLIANCE_PROFILES)) for (const s of scopes) expect(s).toMatch(/^\/api\/[a-z]/);
  });
});
