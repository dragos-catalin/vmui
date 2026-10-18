// Fails (exit 1) when src/locales/ro.json and en.json do not have the same key set,
// or when the "tray" object the Rust side reads with include_str! is missing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const load = (l) => JSON.parse(readFileSync(join(dir, `${l}.json`), "utf8"));
const keys = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]));

const ro = load("ro");
const en = load("en");
const a = new Set(keys(ro));
const b = new Set(keys(en));
const onlyRo = [...a].filter((k) => !b.has(k));
const onlyEn = [...b].filter((k) => !a.has(k));
const problems = [];
if (onlyRo.length) problems.push(`only in ro (${onlyRo.length}):\n  ${onlyRo.join("\n  ")}`);
if (onlyEn.length) problems.push(`only in en (${onlyEn.length}):\n  ${onlyEn.join("\n  ")}`);
for (const [l, o] of [["ro", ro], ["en", en]]) if (!o.tray || typeof o.tray !== "object") problems.push(`${l}: missing top-level "tray" object`);
const empty = [...a].filter((k) => k.split(".").reduce((n, p) => n?.[p], ro) === "" || k.split(".").reduce((n, p) => n?.[p], en) === "");
if (empty.length) problems.push(`empty strings: ${empty.join(", ")}`);

if (problems.length) {
  console.error(`check-locales: FAIL\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`check-locales: OK — ${a.size} keys in ro and en (tray: ${Object.keys(ro.tray).length})`);
