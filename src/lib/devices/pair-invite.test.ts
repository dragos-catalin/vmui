import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// QR pairing: a one-time invite redeemed by the new device, which is then approved
// and bound to the member who showed the QR (so family room grants apply at once).

vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined }));

let P: typeof import("./pairing");
let db: typeof import("@/lib/db").db;
let S: typeof import("@/lib/db/schema");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-inv-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  ({ db } = await import("@/lib/db"));
  S = await import("@/lib/db/schema");
  P = await import("./pairing");
});

describe("pairing invites", () => {
  it("redeems once, approves and binds the device to the inviting member", async () => {
    const { code } = P.createPairingInvite("user-kid", "kid@home");
    const t = await P.redeemPairingInvite(code, "Kid phone", "android", "10.0.0.5", "ro");
    expect(t?.token).toMatch(/^vmd_/);
    const row = db.select().from(S.pairedDevices).all().find((r) => r.id === t!.id)!;
    expect(row.status).toBe("approved");
    expect(row.userId).toBe("user-kid");
    expect(await P.redeemPairingInvite(code, "Again", "android", null, null)).toBeNull();
  });

  it("rejects unknown and expired codes", async () => {
    expect(await P.redeemPairingInvite("x".repeat(22), "n", "android", null, null)).toBeNull();
    vi.useFakeTimers({ now: Date.now() });
    const { code } = P.createPairingInvite("u", "u@home");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(await P.redeemPairingInvite(code, "n", "android", null, null)).toBeNull();
    vi.useRealTimers();
  });
});
