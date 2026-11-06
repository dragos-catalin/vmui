import "server-only";

import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * First-run claim code. Until the first user exists the hub is UNCLAIMED: the home
 * and every token API answer 503 setup_required, and /sign-up asks for this code.
 * The code proves physical access: it is printed in the server log at boot, written
 * to a file next to the database (on the Pi image: the boot partition, readable from
 * any PC that mounts the SD card) and shown on attached screens (ESP / Turzx).
 *
 * VATRA_SETUP_CODE_FILE overrides the location (the image points it at /boot/firmware).
 */

const CODE_LEN = 6;

function codeFile(): string {
  if (process.env.VATRA_SETUP_CODE_FILE) return process.env.VATRA_SETUP_CODE_FILE;
  const db = process.env.VMUI_DB_PATH ?? join(process.cwd(), "vmui.db");
  return join(dirname(db), "vatra-setup-code.txt");
}

let cached: string | null = null;

/** The current claim code, generated once and persisted (survives restarts until claimed). */
export function setupCode(): string {
  if (cached) return cached;
  const f = codeFile();
  try {
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (/^\d{6}$/.test(v)) return (cached = v);
    }
  } catch {
    /* unreadable: regenerate */
  }
  const v = String(randomInt(0, 10 ** CODE_LEN)).padStart(CODE_LEN, "0");
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${v}\n`, { mode: 0o600 });
  } catch {
    /* read-only location: the log line still shows it */
  }
  console.log(`[vatra] hub not claimed yet; setup code: ${v} (also in ${f})`);
  return (cached = v);
}

const attempts: number[] = [];

/** Constant-time compare with a global limit (10 wrong codes / 10 min) against LAN brute force. */
export function checkSetupCode(input: string): "ok" | "wrong" | "locked" {
  const now = Date.now();
  while (attempts.length && now - attempts[0]! > 600_000) attempts.shift();
  if (attempts.length >= 10) return "locked";
  const want = Buffer.from(setupCode());
  const got = Buffer.from(input.replace(/\D/g, "").slice(0, CODE_LEN).padEnd(CODE_LEN, "x"));
  if (got.length === want.length && timingSafeEqual(got, want)) return "ok";
  attempts.push(now);
  return "wrong";
}

/** Once claimed the code is useless; remove it so it cannot be read later. */
export function burnSetupCode(): void {
  cached = null;
  try {
    writeFileSync(codeFile(), "claimed\n", { mode: 0o600 });
  } catch {
    /* ignore */
  }
}
