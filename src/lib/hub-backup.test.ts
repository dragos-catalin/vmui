import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

// Whole-hub backup (P5-06): passphrase-encrypted file holding the database and the key ring;
// a restore is staged, checked, and swapped in at boot on another hub.

let dir: string;
let B: typeof import("./hub-backup");
let R: typeof import("./hub-restore-boot");
let C: typeof import("./crypto");
let E: typeof import("./env");
let raw: typeof import("@/lib/db").rawSqlite;
const PASS = "correct horse battery";

beforeAll(async () => {
  delete process.env.VMUI_MASTER_KEY;
  delete process.env.VATRA_MASTER_KEY_PREV;
  dir = mkdtempSync(join(tmpdir(), "vatra-bk-"));
  process.env.VMUI_DB_PATH = join(dir, "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  ({ rawSqlite: raw } = await import("@/lib/db"));
  C = await import("./crypto");
  E = await import("./env");
  B = await import("./hub-backup");
  R = await import("./hub-restore-boot");
  raw.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('integrations.enc', ?, 0)").run(C.encryptJSON({ HA_TOKEN: "secret-1" }));
});

describe("hub backup", () => {
  it("round-trips the database and the key ring with the passphrase", async () => {
    const { file, info } = await B.createHubBackup(PASS);
    expect(file.subarray(0, 8).toString()).toBe("VATRABK1");
    expect(B.peekHubBackup(file)).toEqual(info);
    const { meta, db } = B.openHubBackup(file, PASS);
    expect(meta.keys.current).toBe(E.requireMasterKey().toString("hex"));
    const snap = join(dir, "peek.db");
    writeFileSync(snap, db);
    const d = new Database(snap, { readonly: true });
    const row = d.prepare("SELECT value FROM app_settings WHERE key='integrations.enc'").get() as { value: string };
    d.close();
    expect(C.decryptJSON<{ HA_TOKEN: string }>(row.value).HA_TOKEN).toBe("secret-1");
  });

  it("does not contain the secrets or the key in clear", async () => {
    const { file } = await B.createHubBackup(PASS);
    const s = file.toString("latin1");
    expect(s).not.toContain(E.requireMasterKey().toString("hex"));
    expect(s).not.toContain("SQLite format 3");
  });

  it("refuses a wrong passphrase, a flipped byte, a swapped header and a short passphrase", async () => {
    const { file } = await B.createHubBackup(PASS);
    expect(() => B.openHubBackup(file, "wrong passphrase!")).toThrow(expect.objectContaining({ code: "passphrase" }));
    const flipped = Buffer.from(file);
    flipped.writeUInt8((flipped[flipped.length - 40] ?? 0) ^ 1, flipped.length - 40);
    expect(() => B.openHubBackup(flipped, PASS)).toThrow(expect.objectContaining({ code: "passphrase" }));
    // header is authenticated: editing host (same length) breaks the tag
    const hdr = Buffer.from(file);
    const at = hdr.indexOf(Buffer.from('"host":"'));
    hdr[at + 8] = hdr[at + 8] === 0x41 ? 0x42 : 0x41;
    expect(() => B.openHubBackup(hdr, PASS)).toThrow(expect.objectContaining({ code: "passphrase" }));
    await expect(B.createHubBackup("short")).rejects.toMatchObject({ code: "weak" });
    expect(() => B.peekHubBackup(Buffer.from("not a backup at all, really"))).toThrow(expect.objectContaining({ code: "format" }));
  });

  it("rejects a file whose database is not a Vatra database", async () => {
    const forge = async (payload: Buffer) => {
      // a correctly encrypted container around an arbitrary payload
      const { createCipheriv, randomBytes, scryptSync } = await import("node:crypto");
      const { gzipSync } = await import("node:zlib");
      const meta = Buffer.from(JSON.stringify({ keys: { current: "cd".repeat(32), prev: [] } }));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(meta.length);
      const plain = gzipSync(Buffer.concat([len, meta, payload]));
      const header = { v: 1, kdf: { name: "scrypt", N: 1024, r: 8, p: 1, salt: randomBytes(16).toString("base64") }, iv: randomBytes(12).toString("base64"), createdAt: "", appVersion: "", host: "x", dbBytes: 7 };
      const hb = Buffer.from(JSON.stringify(header));
      const hl = Buffer.alloc(4);
      hl.writeUInt32BE(hb.length);
      const aad = Buffer.concat([Buffer.from("VATRABK1"), hl, hb]);
      const c = createCipheriv("aes-256-gcm", scryptSync(PASS, Buffer.from(header.kdf.salt, "base64"), 32, { N: 1024, r: 8, p: 1 }), Buffer.from(header.iv, "base64"));
      c.setAAD(aad);
      return Buffer.concat([aad, c.update(plain), c.final(), c.getAuthTag()]);
    };
    // a healthy SQLite file that happens to have an audit_log table, but no users
    const foreignPath = join(dir, "foreign.db");
    const foreign = new Database(foreignPath);
    foreign.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT, target TEXT, status TEXT, message TEXT)");
    foreign.close();
    for (const payload of [Buffer.from("garbage"), readFileSync(foreignPath)]) {
      const forged = await forge(payload);
      expect(() => B.stageHubRestore(forged, PASS, "test")).toThrow(expect.objectContaining({ code: "database" }));
      expect(existsSync(R.stagedPaths().db)).toBe(false);
      expect(existsSync(R.stagedPaths().key)).toBe(false);
    }
  });

  it("stages a restore that swaps in at boot and keeps the replaced files", async () => {
    const { file } = await B.createHubBackup(PASS);
    const oldKey = E.requireMasterKey().toString("hex");
    B.stageHubRestore(file, PASS, "test");
    const p = R.stagedPaths();
    expect(existsSync(p.db) && existsSync(p.key)).toBe(true);
    // the staged copy got the audit row; the live db did not
    const staged = new Database(p.db, { readonly: true });
    expect((staged.prepare("SELECT count(*) n FROM audit_log WHERE action='backup.restore'").get() as { n: number }).n).toBe(1);
    staged.close();

    // simulate "another hub": a different live key file, then boot
    writeFileSync(E.masterKeyFile(), `${"ab".repeat(32)}\n`);
    raw.close();
    expect(R.applyStagedRestore()).toBe(true);
    expect(existsSync(p.db)).toBe(false);
    expect(readFileSync(p.liveKey, "utf8").trim()).toBe(oldKey);
    const kept = readdirSync(dir).filter((f) => f.includes(".pre-restore-"));
    expect(kept.some((f) => f.startsWith("t.db"))).toBe(true);
    expect(kept.some((f) => f.startsWith("vatra-master.key"))).toBe(true);
    expect(R.applyStagedRestore()).toBe(false);
  });
});
