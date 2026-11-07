import "server-only";

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDemo } from "./mode";

// Demo hub lifecycle (P10-04). bootDemo() must run FIRST in instrumentation, before anything
// imports @/lib/db (the db module opens SQLite on import): it wipes the previous database and key,
// then imports the seed. A nightly timer exits the process at 03:00 UTC; Cloud Run starts a new
// container with an empty /tmp, which is the reset.

/** Files of one hub state: the database (+ WAL/SHM), the master key, its .prev and the setup code. */
type Env = Record<string, string | undefined>;

export function demoStateFiles(env: Env = process.env): string[] {
  const db = resolve(env.VMUI_DB_PATH ?? "./vmui.db");
  const key = env.VATRA_MASTER_KEY_FILE ?? join(dirname(db), "vatra-master.key");
  const code = env.VATRA_SETUP_CODE_FILE ?? join(dirname(db), "vatra-setup-code.txt");
  return [db, `${db}-wal`, `${db}-shm`, `${db}.restore`, key, `${key.replace(/\.key$/, "")}.prev`, code];
}

/** Delete the previous hub state. Returns what was removed. Never touches anything else. */
export function wipeDemoState(env: Env = process.env): string[] {
  const removed: string[] = [];
  for (const f of demoStateFiles(env)) {
    if (!existsSync(f)) continue;
    rmSync(f, { force: true });
    removed.push(f);
  }
  return removed;
}

/** Milliseconds until the next 03:00 UTC after `now`. */
export function msUntilNightlyReset(now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

const g = globalThis as { __vatraDemoBooted__?: boolean; __vatraDemoTimer__?: NodeJS.Timeout };

function scheduleNightlyReset(): void {
  if (g.__vatraDemoTimer__) clearTimeout(g.__vatraDemoTimer__);
  g.__vatraDemoTimer__ = setTimeout(() => {
    console.log("[vatra-demo] nightly reset (03:00 UTC): exiting so the container restarts with a fresh /tmp");
    process.exit(0);
  }, msUntilNightlyReset());
  g.__vatraDemoTimer__.unref();
}

/** No-op unless VATRA_DEMO=1. Call before anything imports @/lib/db. */
export async function bootDemo(): Promise<void> {
  if (!isDemo() || g.__vatraDemoBooted__) return;
  g.__vatraDemoBooted__ = true;
  // the house comes from the simulated HA import, never from the original owner's catalog seed
  process.env.VATRA_EMPTY_HOUSE = "1";
  const removed = wipeDemoState();
  if (removed.length) console.log(`[vatra-demo] removed previous state: ${removed.length} file(s)`);
  (await import("@/lib/env")).requireMasterKey();
  const r = await (await import("./seed")).seedDemo();
  console.log(`[vatra-demo] seeded: ${r.created ? `${r.rooms} rooms, ${r.devices} devices` : "already present"}`);
  scheduleNightlyReset();
}
