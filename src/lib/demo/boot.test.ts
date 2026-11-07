import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Cold start of the demo hub: stale files wiped, then a seeded, claimed hub whose house came
// from the simulated HA import and whose reviewer can sign in with the secret password.

const notify = vi.fn(async () => null);
vi.mock("@/lib/notify", () => ({ notify, dismissByTag: async () => undefined }));

describe("bootDemo", () => {
  it("wipes the previous state and seeds the reviewer, house, journal and cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vatra-demo-boot-"));
    process.env.VATRA_DEMO = "1";
    process.env.VMUI_DB_PATH = join(dir, "vmui.db");
    process.env.VATRA_MASTER_KEY_FILE = join(dir, "vatra-master.key");
    process.env.VATRA_SETUP_CODE_FILE = join(dir, "vatra-setup-code.txt");
    process.env.VATRA_DEMO_REVIEW_PASSWORD = "review-pass-123";
    writeFileSync(process.env.VMUI_DB_PATH, "not a sqlite file");
    (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
    try {
      const { bootDemo } = await import("./reset");
      await bootDemo();
      const { userCount, verifyUserPassword } = await import("@/lib/auth");
      expect(await userCount()).toBe(1);
      expect((await verifyUserPassword("review@vatra.dragoscatalin.ro", "review-pass-123")).ok).toBe(true);
      const { house } = await import("@/lib/home/house");
      expect(house().rooms.map((r) => r.id).sort()).toEqual(["bedroom", "hallway", "kitchen", "living_room"]);
      const { mealsForDay } = await import("@/lib/nutrition/store");
      expect((await mealsForDay()).length).toBeGreaterThanOrEqual(1);
      expect(notify).toHaveBeenCalled();
    } finally {
      for (const k of ["VATRA_DEMO", "VATRA_MASTER_KEY_FILE", "VATRA_SETUP_CODE_FILE", "VATRA_DEMO_REVIEW_PASSWORD", "VATRA_EMPTY_HOUSE"]) delete process.env[k];
      (await import("./sim-ha")).resetSim();
    }
  });
});
