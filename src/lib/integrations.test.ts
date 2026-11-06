import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Integration secrets live encrypted in SQLite; credential() resolves env -> store -> file.
// A fresh hub generates its own master key file (no `pnpm keygen`).

async function fresh() {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "vatra-int-"));
  process.env.VMUI_DB_PATH = join(dir, "t.db");
  process.env.VMUI_CREDENTIALS_FILE = join(dir, "none.env");
  // the legacy file fallback also looks at <cwd>/.private/credentials.env: isolate from the real one
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.VMUI_MASTER_KEY;
  delete process.env.HA_URL;
  delete process.env.HA_TOKEN;
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const int = await import("./integrations");
  const cred = await import("./home/credentials");
  const { db } = await import("./db");
  const s = await import("./db/schema");
  return { int, cred, db, s, dir };
}

describe("integrations store", () => {
  it("generates a 0600 master key file on first use", async () => {
    const { int, dir } = await fresh();
    int.writeIntegrations({ HA_URL: "http://ha.local:8123" });
    expect(readFileSync(join(dir, "vatra-master.key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("credential() reads values written from the UI, encrypted at rest", async () => {
    const { int, cred, db, s } = await fresh();
    int.writeIntegrations({ HA_URL: "http://ha.local:8123", HA_TOKEN: "secret-token-123" });
    expect(cred.credential("HA_URL")).toBe("http://ha.local:8123");
    expect(cred.haConfig()?.token).toBe("secret-token-123");
    const raw = db.select().from(s.settings).all().find((r) => r.key === "integrations.enc")!.value;
    expect(raw).not.toContain("secret-token-123");
  });

  it("env still wins; empty string deletes; unknown keys are ignored", async () => {
    const { int, cred } = await fresh();
    int.writeIntegrations({ HA_URL: "http://a" });
    process.env.HA_URL = "http://env";
    expect(cred.credential("HA_URL")).toBe("http://env");
    delete process.env.HA_URL;
    int.writeIntegrations({ HA_URL: "" , ...({ EVIL: "x" } as object) });
    expect(cred.credential("HA_URL")).toBeUndefined();
    expect(cred.credential("EVIL")).toBeUndefined();
  });

  it("the view never echoes secrets", async () => {
    const { int, cred } = await fresh();
    int.writeIntegrations({ HA_URL: "http://a", HA_TOKEN: "t" });
    const v = int.integrationsView((k) => cred.credential(k));
    expect(v.HA_TOKEN).toEqual({ set: true, value: null });
    expect(v.HA_URL).toEqual({ set: true, value: "http://a" });
  });
});
