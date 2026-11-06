import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Master key rotation (P2-04): ciphertext carries a key id, retired keys keep old rows
// readable, and a rotation re-seals every *_enc column + the encrypted settings row.

let dir: string;
let C: typeof import("./crypto");
let R: typeof import("./rekey");
let E: typeof import("./env");
let raw: typeof import("@/lib/db").rawSqlite;

/** The pre-v1 format: base64(iv | tag | ct), no key id. */
function legacy(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

beforeAll(async () => {
  delete process.env.VMUI_MASTER_KEY;
  delete process.env.VATRA_MASTER_KEY_PREV;
  dir = mkdtempSync(join(tmpdir(), "vatra-rekey-"));
  process.env.VMUI_DB_PATH = join(dir, "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  ({ rawSqlite: raw } = await import("@/lib/db"));
  C = await import("./crypto");
  E = await import("./env");
  R = await import("./rekey");
});

describe("master key rotation", () => {
  it("tags new ciphertext with the current key id", () => {
    const c = C.encrypt("x");
    expect(c.startsWith(`v1.${C.keyId(E.requireMasterKey())}.`)).toBe(true);
    expect(C.isCurrent(c)).toBe(true);
  });

  it("still opens legacy untagged payloads", () => {
    const key = readFileSync(E.masterKeyFile(), "utf8").trim();
    expect(C.decrypt(legacy("old row", key))).toBe("old row");
  });

  it("finds every *_enc column from the live schema", () => {
    const cols = R.encryptedColumns().map((t) => `${t.table}.${t.column}`);
    expect(cols).toContain("users.totp_secret_enc");
    expect(cols).toContain("secrets.value_enc");
    expect(cols.length).toBeGreaterThanOrEqual(10);
  });

  it("rotates: new key, every row re-sealed and readable, retired key dropped", () => {
    const oldKey = readFileSync(E.masterKeyFile(), "utf8").trim();
    raw.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("integrations.enc", C.encryptJSON({ HA_TOKEN: "t0k" }));
    const t = R.encryptedColumns().find((x) => x.table === "secrets")!;
    const cols = raw.prepare(`PRAGMA table_info(secrets)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>;
    const row: Record<string, unknown> = {};
    for (const c of cols) if (c.notnull && c.dflt_value === null && !c.pk) row[c.name] = c.name.endsWith("_at") ? Date.now() : "x";
    row[t.pk] = "s1";
    row[t.column] = legacy("db-password", oldKey);
    raw.prepare(`INSERT INTO secrets (${Object.keys(row).map((k) => `"${k}"`).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));

    const report = R.rotateMasterKey();
    expect(report.rows).toBeGreaterThanOrEqual(2);
    expect(readFileSync(E.masterKeyFile(), "utf8").trim()).not.toBe(oldKey);
    expect(existsSync(join(dir, "vatra-master.prev"))).toBe(false);

    const sealed = (raw.prepare(`SELECT "${t.column}" AS v FROM secrets WHERE "${t.pk}" = 's1'`).get() as { v: string }).v;
    expect(C.isCurrent(sealed)).toBe(true);
    expect(C.decrypt(sealed)).toBe("db-password");
    const setting = (raw.prepare("SELECT value FROM app_settings WHERE key = 'integrations.enc'").get() as { value: string }).value;
    expect(C.decryptJSON(setting)).toEqual({ HA_TOKEN: "t0k" });

    // a second run has nothing left to do
    expect(R.reencryptAll().rows).toBe(0);
  });

  it("refuses a payload whose key id is not in the ring", () => {
    const forged = `v1.deadbeef.${Buffer.alloc(40).toString("base64")}`;
    expect(() => C.decrypt(forged)).toThrow(/deadbeef/);
  });
});
