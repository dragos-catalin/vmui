import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { rawSqlite } from "@/lib/db";
import { masterKeyFromEnv, previousMasterKeys, requireMasterKey } from "@/lib/env";
import { stagedPaths } from "@/lib/hub-restore-boot";
import { redactQuiet } from "@/lib/secret-redactor";

/**
 * Whole-hub backup (P5-06): one file, `VATRABK1 | u32 header length | header JSON | ciphertext | tag`.
 * The ciphertext is AES-256-GCM under scrypt(passphrase) with the header as additional data (so
 * the KDF parameters cannot be swapped), over gzip(u32 meta length | meta JSON | SQLite snapshot).
 * The meta carries the master key ring: the file alone plus the passphrase restores every stored
 * secret on a different hub. The passphrase is never stored; losing it loses the backup.
 */

const MAGIC = Buffer.from("VATRABK1");
const KDF = { name: "scrypt", N: 1 << 16, r: 8, p: 1 } as const;
const MAXMEM = 256 * 1024 * 1024;
export const MIN_PASSPHRASE = 12;
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export type BackupErrorCode = "format" | "passphrase" | "version" | "database" | "weak";
export class BackupError extends Error {
  constructor(public code: BackupErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BackupError";
  }
}

interface Header {
  v: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  createdAt: string;
  appVersion: string;
  host: string;
  dbBytes: number;
}
interface Meta {
  keys: { current: string; prev: string[] };
}
export interface BackupInfo {
  createdAt: string;
  appVersion: string;
  host: string;
  dbBytes: number;
}

function deriveKey(passphrase: string, kdf: Header["kdf"]): Buffer {
  if (kdf.name !== "scrypt" || kdf.N > 1 << 20 || kdf.r > 16 || kdf.p > 4) throw new BackupError("format", "unsupported kdf parameters");
  return scryptSync(passphrase.normalize("NFKC"), Buffer.from(kdf.salt, "base64"), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
}

/** Consistent online copy of the live database (SQLite backup API; writers keep going). */
async function snapshotDb(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "vatra-bk-"));
  const file = join(dir, "snap.db");
  try {
    await rawSqlite.backup(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function createHubBackup(passphrase: string): Promise<{ file: Buffer; info: BackupInfo }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new BackupError("weak");
  const db = await snapshotDb();
  const meta: Meta = {
    keys: { current: requireMasterKey().toString("hex"), prev: previousMasterKeys().map((k) => k.toString("hex")) },
  };
  const metaBuf = Buffer.from(JSON.stringify(meta));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(metaBuf.length);
  const plain = gzipSync(Buffer.concat([len, metaBuf, db]));

  const header: Header = {
    v: 1,
    kdf: { ...KDF, salt: randomBytes(16).toString("base64") },
    iv: randomBytes(12).toString("base64"),
    createdAt: new Date().toISOString(),
    appVersion: process.env.VATRA_VERSION ?? "0.0.0",
    host: hostname(),
    dbBytes: db.length,
  };
  const headerBuf = Buffer.from(JSON.stringify(header));
  const hlen = Buffer.alloc(4);
  hlen.writeUInt32BE(headerBuf.length);
  const aad = Buffer.concat([MAGIC, hlen, headerBuf]);

  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, header.kdf), Buffer.from(header.iv, "base64"));
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const { v: _v, kdf: _k, iv: _i, ...info } = header;
  return { file: Buffer.concat([aad, ct, cipher.getAuthTag()]), info };
}

/** Header without the passphrase: what the restore UI shows before asking for it. */
export function peekHubBackup(file: Buffer): BackupInfo {
  return parseHeader(file).info;
}

function parseHeader(file: Buffer): { header: Header; aad: Buffer; info: BackupInfo } {
  if (file.length < MAGIC.length + 4 + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("format");
  const hlen = file.readUInt32BE(MAGIC.length);
  if (hlen > 4096 || MAGIC.length + 4 + hlen + 16 > file.length) throw new BackupError("format");
  let header: Header;
  try {
    header = JSON.parse(file.subarray(MAGIC.length + 4, MAGIC.length + 4 + hlen).toString("utf8")) as Header;
  } catch {
    throw new BackupError("format");
  }
  if (header.v !== 1) throw new BackupError("version");
  const { v: _v, kdf: _k, iv: _i, ...info } = header;
  return { header, aad: file.subarray(0, MAGIC.length + 4 + hlen), info };
}

export function openHubBackup(file: Buffer, passphrase: string): { info: BackupInfo; meta: Meta; db: Buffer } {
  const { header, aad, info } = parseHeader(file);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, header.kdf), Buffer.from(header.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(file.subarray(file.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(file.subarray(aad.length, file.length - 16)), decipher.final()]);
  } catch {
    // GCM cannot tell a wrong passphrase from a modified file; both mean "not this passphrase"
    throw new BackupError("passphrase");
  }
  const inner = gunzipSync(plain);
  const mlen = inner.readUInt32BE(0);
  const meta = JSON.parse(inner.subarray(4, 4 + mlen).toString("utf8")) as Meta;
  const db = inner.subarray(4 + mlen);
  const hex = /^[0-9a-f]{64}$/i;
  if (!hex.test(meta.keys?.current ?? "") || !meta.keys.prev.every((k) => hex.test(k))) throw new BackupError("format");
  return { info, meta, db };
}

/**
 * Verify, check the database, and stage it next to the live files. `applyStagedRestore()` swaps
 * them in at the next boot, before anything opens the database; the caller restarts the process.
 */
export function stageHubRestore(file: Buffer, passphrase: string, actor: string): BackupInfo {
  const { info, meta, db } = openHubBackup(file, passphrase);
  const p = stagedPaths();
  writeFileSync(p.db, db, { mode: 0o600 });
  try {
    const check = new Database(p.db);
    // the audit_log trigger calls this UDF (db/index.ts)
    check.function("vmui_redact", { deterministic: false }, (msg: unknown) => (typeof msg === "string" && msg ? redactQuiet(msg) : (msg as string | null)));
    try {
      const ok = (check.pragma("integrity_check", { simple: true }) as string) === "ok";
      const hasUsers = Boolean(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get());
      if (!ok || !hasUsers) throw new BackupError("database");
      check.prepare("INSERT INTO audit_log (action, target, status, message) VALUES ('backup.restore', ?, 'ok', ?)")
        .run(actor, `from ${info.host} ${info.createdAt} (v${info.appVersion})`);
    } finally {
      check.close();
    }
  } catch (e) {
    rmSync(p.db, { force: true });
    throw e instanceof BackupError ? e : new BackupError("database", String(e));
  }
  // env-pinned key stays current; the backup's ring joins the retired keys so its rows stay readable
  const pinned = masterKeyFromEnv();
  const ring = pinned ? [meta.keys.current, ...meta.keys.prev] : meta.keys.prev;
  if (!pinned) writeFileSync(p.key, `${meta.keys.current}\n`, { mode: 0o600 });
  writeFileSync(p.prev, ring.length ? `${ring.join("\n")}\n` : "", { mode: 0o600 });
  for (const f of [p.db, p.key, p.prev]) if (existsSync(f)) try { chmodSync(f, 0o600); } catch { /* Windows */ }
  return info;
}
