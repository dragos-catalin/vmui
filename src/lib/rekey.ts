import "server-only";

import { decrypt, encrypt, isCurrent } from "@/lib/crypto";
import { rawSqlite } from "@/lib/db";
import { dropPreviousMasterKeys, installNewMasterKey, masterKeyFromEnv } from "@/lib/env";

/** Settings rows whose `value` is a ciphertext (the rest of app_settings is plain JSON). */
const ENCRYPTED_SETTINGS = ["integrations.enc"];

type Target = { table: string; column: string; pk: string };

/** Every `*_enc` column in the schema, found from SQLite itself so a new table is never missed. */
export function encryptedColumns(): Target[] {
  const tables = rawSqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as Array<{ name: string }>;
  const out: Target[] = [];
  for (const { name } of tables) {
    const cols = rawSqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; pk: number }>;
    const pk = cols.find((c) => c.pk === 1)?.name ?? "rowid";
    for (const c of cols) if (c.name.endsWith("_enc")) out.push({ table: name, column: c.name, pk });
  }
  return out;
}

export interface RekeyReport {
  rows: number;
  skipped: number;
  columns: number;
}

/** Re-seal every stored ciphertext with the current key, in one transaction (all or nothing). */
export function reencryptAll(): RekeyReport {
  const targets = encryptedColumns();
  let rows = 0;
  let skipped = 0;
  rawSqlite.transaction(() => {
    for (const t of targets) {
      const list = rawSqlite.prepare(`SELECT "${t.pk}" AS id, "${t.column}" AS v FROM "${t.table}" WHERE "${t.column}" IS NOT NULL AND "${t.column}" <> ''`).all() as Array<{ id: unknown; v: string }>;
      const upd = rawSqlite.prepare(`UPDATE "${t.table}" SET "${t.column}" = ? WHERE "${t.pk}" = ?`);
      for (const r of list) {
        if (isCurrent(r.v)) { skipped++; continue; }
        upd.run(encrypt(decrypt(r.v)), r.id);
        rows++;
      }
    }
    const sel = rawSqlite.prepare(`SELECT value FROM app_settings WHERE key = ?`);
    const upd = rawSqlite.prepare(`UPDATE app_settings SET value = ? WHERE key = ?`);
    for (const k of ENCRYPTED_SETTINGS) {
      const row = sel.get(k) as { value: string } | undefined;
      if (!row) continue;
      if (isCurrent(row.value)) { skipped++; continue; }
      upd.run(encrypt(decrypt(row.value)), k);
      rows++;
    }
  })();
  return { rows, skipped, columns: targets.length + ENCRYPTED_SETTINGS.length };
}

/** Full rotation: new file key, every row re-sealed, then the retired key is dropped.
 *  If re-encryption fails the transaction rolls back and the retired key stays in
 *  `vatra-master.prev`, so nothing becomes unreadable. */
export function rotateMasterKey(): RekeyReport & { file: string } {
  if (masterKeyFromEnv()) throw new Error("master key is pinned by VMUI_MASTER_KEY: change the env value and run `pnpm rekey` with VATRA_MASTER_KEY_PREV set");
  const { file } = installNewMasterKey();
  const report = reencryptAll();
  dropPreviousMasterKeys();
  return { ...report, file };
}
