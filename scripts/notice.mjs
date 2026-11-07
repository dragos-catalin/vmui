#!/usr/bin/env node
// NOTICE pipeline (P11-01). Generates NOTICE.md from the production dependency tree and, with
// --check, fails when NOTICE.md is stale or a production dependency has a licence outside the
// allow-list. Logic lives in src/lib/legal/notice-core.ts (Node 24 strips the types; vitest
// tests the same module).
//
//   node scripts/notice.mjs            write NOTICE.md
//   node scripts/notice.mjs --check    exit 1 on a stale NOTICE.md or a disallowed licence
//   node scripts/notice.mjs --input f  read a saved `pnpm licenses list --prod --json` instead
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// package.json has no "type"; Node would print MODULE_TYPELESS_PACKAGE_JSON for the .ts import.
process.removeAllListeners("warning");
const { findViolations, flattenLicenses, normalizeNewlines, renderNotice } = await import("../src/lib/legal/notice-core.ts");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const inputIdx = args.indexOf("--input");
const noticePath = resolve(root, "NOTICE.md");

function readLicenses() {
  if (inputIdx >= 0 && args[inputIdx + 1]) return JSON.parse(readFileSync(resolve(args[inputIdx + 1]), "utf8"));
  const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out.slice(out.indexOf("{")));
}

const entries = flattenLicenses(readLicenses());
const violations = findViolations(entries);
const rendered = normalizeNewlines(renderNotice(entries));
let failed = false;

if (violations.length) {
  failed = true;
  console.error(`Licences outside the allow-list (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v.name}@${v.version}: ${v.license}`);
  console.error("Fix: replace the package, or add the licence / a verified override in src/lib/legal/notice-core.ts.");
}

if (check) {
  const current = existsSync(noticePath) ? normalizeNewlines(readFileSync(noticePath, "utf8")) : "";
  if (current !== rendered) {
    failed = true;
    console.error("NOTICE.md is stale: run `node scripts/notice.mjs` and commit the result.");
  }
  if (!failed) console.log(`NOTICE.md up to date; ${entries.length} production packages, all licences allowed.`);
} else {
  writeFileSync(noticePath, rendered);
  console.log(`NOTICE.md written: ${entries.length} production packages${violations.length ? `, ${violations.length} disallowed` : ""}.`);
}

process.exit(failed ? 1 : 0);
