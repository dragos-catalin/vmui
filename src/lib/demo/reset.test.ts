import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { msUntilNightlyReset, wipeDemoState } from "./reset";

describe("demo reset", () => {
  it("removes a stale database, WAL and key, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "vatra-demo-reset-"));
    const env = { VMUI_DB_PATH: join(dir, "vmui.db"), VATRA_MASTER_KEY_FILE: join(dir, "vatra-master.key") };
    for (const f of ["vmui.db", "vmui.db-wal", "vatra-master.key", "keep.txt"]) writeFileSync(join(dir, f), "x");
    const removed = wipeDemoState(env);
    expect(removed).toHaveLength(3);
    expect(existsSync(join(dir, "vmui.db"))).toBe(false);
    expect(existsSync(join(dir, "vmui.db-wal"))).toBe(false);
    expect(existsSync(join(dir, "vatra-master.key"))).toBe(false);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    expect(wipeDemoState(env)).toEqual([]);
  });

  it("schedules the nightly reset at the next 03:00 UTC", () => {
    expect(msUntilNightlyReset(new Date("2026-11-07T02:00:00Z"))).toBe(3_600_000);
    expect(msUntilNightlyReset(new Date("2026-11-07T03:00:00Z"))).toBe(86_400_000);
    expect(msUntilNightlyReset(new Date("2026-11-07T22:30:00Z"))).toBe(4.5 * 3_600_000);
  });
});
