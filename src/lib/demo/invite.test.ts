import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined }));

const INVITE = "demo-invite-0123456789abcdef";
let P: typeof import("@/lib/devices/pairing");
let reviewerId: string;

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-demo-inv-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  const { createUser } = await import("@/lib/auth");
  const { DEMO_REVIEWER_EMAIL } = await import("./invite");
  reviewerId = (await createUser({ email: DEMO_REVIEWER_EMAIL, displayName: "Review", password: "review-pass-123", role: "admin" })).id;
  P = await import("@/lib/devices/pairing");
});

afterEach(() => {
  delete process.env.VATRA_DEMO;
  delete process.env.VATRA_DEMO_INVITE;
});

describe("demo static pairing invite", () => {
  it("redeems many times as the reviewer on the demo hub", async () => {
    process.env.VATRA_DEMO = "1";
    process.env.VATRA_DEMO_INVITE = INVITE;
    const { db } = await import("@/lib/db");
    const S = await import("@/lib/db/schema");
    const a = await P.redeemPairingInvite(INVITE, "Reviewer iPhone", "ios", null, "en");
    const b = await P.redeemPairingInvite(INVITE, "Reviewer Pixel", "android", null, "en");
    expect(a?.token).toMatch(/^vmd_/);
    expect(b?.token).toMatch(/^vmd_/);
    expect(a?.id).not.toBe(b?.id);
    const rows = db.select().from(S.pairedDevices).all().filter((r) => r.id === a!.id || r.id === b!.id);
    expect(rows.every((r) => r.status === "approved" && r.userId === reviewerId)).toBe(true);
    expect(await P.redeemPairingInvite("x".repeat(INVITE.length), "n", "ios", null, null)).toBeNull();
  });

  it("is rejected when the hub is not a demo hub", async () => {
    process.env.VATRA_DEMO_INVITE = INVITE;
    expect(await P.redeemPairingInvite(INVITE, "n", "ios", null, null)).toBeNull();
  });

  it("ignores a malformed VATRA_DEMO_INVITE", async () => {
    process.env.VATRA_DEMO = "1";
    process.env.VATRA_DEMO_INVITE = "short";
    expect(await P.redeemPairingInvite("short-but-not-16", "n", "ios", null, null)).toBeNull();
  });
});
