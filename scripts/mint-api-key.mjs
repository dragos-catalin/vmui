// Mint a vmui_* API key from the CLI (same scrypt format as src/lib/auth.ts).
// Usage: node scripts/mint-api-key.mjs "codai phone" operator [--preset stream] [--rate 120]
// Prints the plaintext ONCE; store it in the client, never in the repo.
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => {
	const i = argv.indexOf(`--${n}`);
	if (i < 0) return undefined;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const preset = flag("preset");
const rate = Number(flag("rate") ?? 120);
const [name = "cli", role = "operator"] = argv;
if (!["operator", "viewer"].includes(role)) throw new Error("role must be operator|viewer");
if (!Number.isInteger(rate) || rate < 1 || rate > 10000) throw new Error("--rate must be 1..10000");

// Presets with argument limits live in JSON so the app (src/lib/api-key-scopes.ts) and this script agree.
let scopes = null;
if (preset) {
	if (preset !== "stream") throw new Error("--preset must be stream (use the settings UI for the others)");
	if (role !== "operator") throw new Error("--preset needs the operator role");
	scopes = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src/lib/mcp/stream-preset.json"), "utf8"));
}

const plaintext = `vmui_${Buffer.from(randomBytes(32)).toString("base64url")}`;
const salt = randomBytes(16);
const key = await new Promise((res, rej) => scrypt(plaintext, salt, 64, (e, k) => (e ? rej(e) : res(k))));
const hash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
// Same as apiKeyLookupId() in src/lib/api-auth.ts.
const lookupId = createHash("sha256").update(plaintext).digest("hex").slice(0, 16);

const db = new Database(resolve(process.cwd(), process.env.VMUI_DB_PATH ?? "./vmui.db"));
const cols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
if (!cols.includes("lookup_id")) throw new Error("api_keys.lookup_id missing: start vmui once (it migrates on boot), then retry");
db.prepare("INSERT INTO api_keys (id, name, hash, role, rate_limit_per_minute, scopes, lookup_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
	randomUUID(), name, hash, role, rate, scopes ? JSON.stringify(scopes) : null, lookupId,
);
db.close();
process.stdout.write(plaintext + "\n");
