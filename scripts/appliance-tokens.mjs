// Per-appliance tokens (P3-03) that replace the shared ESP_DISPLAY_TOKEN for the house's own hardware.
//   node scripts/appliance-tokens.mjs generate [--env .private/credentials.env]
//       PC side: appends VATRA_TOKEN_<PROFILE>=vmd_… for every profile that has none (never rewrites one).
//   node scripts/appliance-tokens.mjs register [--env …] [--db vmui.db]
//       Hub side (after vmui migrated): makes sure each token's sha256 is an approved appliance row
//       with its profile's scopes. A row the owner revoked stays revoked; rotate with `generate --rotate <profile>`.
// Never prints a token.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const profiles = JSON.parse(readFileSync(resolve(here, "../src/lib/devices/appliance-profiles.json"), "utf8"));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};
const envPath = resolve(opt("env", ".private/credentials.env"));
const dbPath = resolve(opt("db", process.env.VMUI_DB_PATH ?? "vmui.db"));

export const envKey = (profile) => `VATRA_TOKEN_${profile.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
const NAMES = { esp32: "ESP32 display", deskButton: "Desk button", nestHub: "Nest Hub", turzx: "Desk screen (Turzx)", homeAssistant: "Home Assistant", pcAgent: "PC agent" };

function readEnv() {
  const out = new Map();
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim().replace(/^"|"$/g, ""));
  }
  return out;
}

function generate() {
  const env = readEnv();
  const rotate = opt("rotate");
  if (rotate && !(rotate in profiles)) throw new Error(`unknown profile ${rotate}`);
  if (rotate) {
    const k = envKey(rotate);
    const kept = readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => !l.startsWith(`${k}=`));
    writeFileSync(envPath, kept.join("\n"));
    env.delete(k);
  }
  const added = [];
  for (const p of Object.keys(profiles)) {
    const k = envKey(p);
    if (env.get(k)?.startsWith("vmd_")) continue;
    appendFileSync(envPath, `\n${k}=vmd_${randomBytes(24).toString("base64url")}`);
    added.push(k);
  }
  console.log(added.length ? `added ${added.join(", ")}` : "all appliance tokens present");
}

async function register() {
  const { default: Database } = await import("better-sqlite3");
  const env = readEnv();
  const db = new Database(dbPath);
  // audit_log's insert trigger calls the app's redaction function; these messages hold only names
  db.function("vmui_redact", { deterministic: false }, (m) => m);
  const cols = new Set(db.prepare("PRAGMA table_info(paired_devices)").all().map((c) => c.name));
  if (!cols.size) throw new Error("paired_devices missing: start vmui once (it creates the schema), then retry");
  // same column vmui adds on boot (src/lib/db/index.ts); either side may win the race
  for (const c of ["user_id", "scopes"]) {
    if (cols.has(c)) continue;
    try {
      db.exec(`ALTER TABLE paired_devices ADD COLUMN ${c} TEXT`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) throw e;
    }
  }
  const owner =
    db.prepare("SELECT user_id AS id FROM home_members WHERE role = 'owner' ORDER BY created_at LIMIT 1").get()?.id ??
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get()?.id ??
    null;
  const find = db.prepare("SELECT id, status FROM paired_devices WHERE token_hash = ?");
  const insert = db.prepare("INSERT INTO paired_devices (id, name, platform, token_hash, status, approved_by, user_id, scopes) VALUES (?, ?, ?, ?, 'approved', 'appliance-tokens', ?, ?)");
  const rescope = db.prepare("UPDATE paired_devices SET scopes = ?, platform = ? WHERE id = ?");
  const audit = db.prepare("INSERT INTO audit_log (account_id, action, target, status, message) VALUES ('devices', 'device.appliance.register', ?, 'ok', ?)");
  const report = [];
  for (const [p, scopes] of Object.entries(profiles)) {
    const tok = env.get(envKey(p));
    if (!tok?.startsWith("vmd_")) {
      report.push(`${p}: no token`);
      continue;
    }
    const hash = createHash("sha256").update(tok).digest("hex");
    const row = find.get(hash);
    if (row) {
      rescope.run(JSON.stringify(scopes), `appliance:${p}`, row.id);
      report.push(`${p}: ${row.status}`);
      continue;
    }
    const id = randomBytes(8).toString("hex");
    insert.run(id, NAMES[p] ?? p, `appliance:${p}`, hash, owner, JSON.stringify(scopes));
    audit.run(id, `${NAMES[p] ?? p} (${p}) registered from credentials`);
    report.push(`${p}: registered`);
  }
  db.close();
  console.log(report.join("; "));
}

const cmd = argv[0];
if (cmd === "generate") generate();
else if (cmd === "register") await register();
else {
  console.error("usage: appliance-tokens.mjs generate|register [--env path] [--db path] [--rotate profile]");
  process.exit(2);
}
