#!/usr/bin/env node
// Parses every string in messages/**/{en,ro}.json with the same ICU parser next-intl
// uses at runtime (intl-messageformat via use-intl). A message that fails here throws
// INVALID_MESSAGE in the browser. Exit 1 on any parse error.
import { realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm: intl-messageformat is a dependency of use-intl, which is a dependency of next-intl.
// Follow the real (symlink-resolved) package dirs; their `exports` hide package.json.
const nextIntlDir = realpathSync(join(root, "node_modules", "next-intl"));
const useIntlDir = realpathSync(join(nextIntlDir, "..", "use-intl"));
const imfEntry = createRequire(join(useIntlDir, "package.json")).resolve("intl-messageformat");
const mod = await import(pathToFileURL(imfEntry).href);
const IntlMessageFormat = mod.IntlMessageFormat ?? mod.default;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/^(en|ro)\.json$/.test(name)) yield p;
  }
}

function* strings(obj, path = []) {
  if (typeof obj === "string") yield [path.join("."), obj];
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) yield* strings(v, [...path, k]);
}

let files = 0;
let checked = 0;
const errors = [];
for (const file of walk(join(root, "messages"))) {
  files++;
  const locale = file.endsWith("ro.json") ? "ro" : "en";
  const rel = relative(root, file).replaceAll("\\", "/");
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`${rel}: invalid JSON: ${e.message}`);
    continue;
  }
  for (const [key, msg] of strings(json)) {
    checked++;
    try {
      new IntlMessageFormat(msg, locale);
    } catch (e) {
      errors.push(`${rel} ${key}: ${e.message.split("\n")[0]}\n    ${JSON.stringify(msg)}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} invalid message(s) in ${files} files (${checked} strings checked).`);
  process.exit(1);
}
console.log(`ok: ${checked} strings in ${files} files parse as ICU messages.`);
