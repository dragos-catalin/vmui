import "server-only";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  VMUI_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "VMUI_MASTER_KEY must be a 64-char hex string (32 bytes). Run `pnpm keygen`.")
    .optional(),
  VMUI_DB_PATH: z.string().min(1).default("./vmui.db"),
  VMUI_ANOMALY_WEBHOOK: z.url().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = schema.safeParse({
  VMUI_MASTER_KEY: process.env.VMUI_MASTER_KEY,
  VMUI_DB_PATH: process.env.VMUI_DB_PATH,
  VMUI_ANOMALY_WEBHOOK: process.env.VMUI_ANOMALY_WEBHOOK,
  NODE_ENV: process.env.NODE_ENV,
});

if (!parsed.success) {
  // Surface a useful message but don't crash on import for keygen workflow
  console.warn("[vmui] env validation issue:", parsed.error.issues.map((i) => i.message).join("; "));
}

export const env = parsed.success
  ? parsed.data
  : {
      VMUI_MASTER_KEY: process.env.VMUI_MASTER_KEY,
      VMUI_DB_PATH: process.env.VMUI_DB_PATH ?? "./vmui.db",
      VMUI_ANOMALY_WEBHOOK: process.env.VMUI_ANOMALY_WEBHOOK,
      NODE_ENV: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test",
    };

/**
 * The env var wins (existing installs). Otherwise the key lives in `vatra-master.key`
 * next to the database, generated on first use with mode 0600: a fresh appliance never
 * runs without encryption and nobody has to run `pnpm keygen`. Losing that file makes
 * stored secrets unreadable, so it is part of every backup (P5-06).
 */
let fileKey: string | null = null;
export function masterKeyFile(): string {
  return process.env.VATRA_MASTER_KEY_FILE ?? join(dirname(resolve(env.VMUI_DB_PATH)), "vatra-master.key");
}

export function requireMasterKey(): Buffer {
  if (env.VMUI_MASTER_KEY) return Buffer.from(env.VMUI_MASTER_KEY, "hex");
  if (!fileKey) {
    const f = masterKeyFile();
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (!/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${f} is not a 64-char hex key`);
      fileKey = v;
    } else {
      fileKey = randomBytes(32).toString("hex");
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${fileKey}\n`, { mode: 0o600, flag: "wx" });
      try { chmodSync(f, 0o600); } catch { /* Windows */ }
      console.log(`[vatra] generated master key at ${f} (back it up with the database)`);
    }
  }
  return Buffer.from(fileKey, "hex");
}
