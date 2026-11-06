import "server-only";

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env, masterKeyFile } from "@/lib/env";

/**
 * Staged restore (P5-06), applied at boot before anything opens the database. Kept apart from
 * hub-backup.ts so instrumentation can import it without pulling in the db module.
 */
export function stagedPaths() {
  const db = resolve(env.VMUI_DB_PATH);
  const key = masterKeyFile();
  return {
    liveDb: db,
    liveKey: key,
    livePrev: `${key.replace(/\.key$/, "")}.prev`,
    db: `${db}.restore`,
    key: `${key}.restore`,
    prev: `${key.replace(/\.key$/, "")}.prev.restore`,
  };
}

/** Swap a staged restore in. The replaced files stay as `*.pre-restore-<ts>` (manual undo). */
export function applyStagedRestore(): boolean {
  const p = stagedPaths();
  if (!existsSync(p.db)) return false;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const keep = (f: string) => existsSync(f) && renameSync(f, `${f}.pre-restore-${ts}`);
  keep(p.liveDb);
  for (const s of ["-wal", "-shm"]) rmSync(p.liveDb + s, { force: true });
  renameSync(p.db, p.liveDb);
  if (existsSync(p.key)) {
    keep(p.liveKey);
    renameSync(p.key, p.liveKey);
  }
  if (existsSync(p.prev)) {
    keep(p.livePrev);
    renameSync(p.prev, p.livePrev);
  }
  console.log(`[vatra] restored a backup into ${dirname(p.liveDb)} (previous files kept as *.pre-restore-${ts})`);
  return true;
}
