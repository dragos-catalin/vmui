#!/usr/bin/env node
// First-load JS per app route after `next build` (Turbopack or webpack).
// Output: test-results/bundles/summary.json (raw + gzip bytes per route, shared root chunks).
//
// Sources, in order:
//  1. .next/app-build-manifest.json (webpack builds: pages -> chunk list)
//  2. Turbopack / Next 16: .next/server/app/**/page_client-reference-manifest.js
//     (`entryJSFiles` = every layout/page/error/loading entry of that route) + rootMainFiles
//     from .next/build-manifest.json; route names from .next/app-path-routes-manifest.json.
// polyfillFiles are nomodule (not loaded by modern browsers) and are excluded.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const NEXT = join(ROOT, process.env.NEXT_DIR ?? ".next");
const OUT = join(ROOT, "test-results", "bundles");
if (!existsSync(NEXT)) {
  console.error(`bundles: ${NEXT} not found — run next build first`);
  process.exit(1);
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const sizeCache = new Map();
/** Chunk paths appear as "static/chunks/x.js" or "/_next/static/chunks/x.js". */
function chunkSize(chunk) {
  const relPath = chunk.replace(/^\/?_next\//, "").replace(/^\//, "");
  if (sizeCache.has(relPath)) return sizeCache.get(relPath);
  const file = join(NEXT, relPath);
  let v = { raw: 0, gzip: 0, missing: true };
  if (existsSync(file)) {
    const buf = readFileSync(file);
    v = { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, missing: false };
  }
  sizeCache.set(relPath, v);
  return v;
}
const isJs = (c) => /\.m?js(\?|$)/.test(c);
const norm = (c) => c.replace(/^\/?_next\//, "").replace(/^\//, "");

function total(chunks) {
  let raw = 0, gzip = 0, missing = 0;
  for (const c of chunks) {
    const s = chunkSize(c);
    raw += s.raw;
    gzip += s.gzip;
    if (s.missing) missing++;
  }
  return { raw, gzip, files: chunks.length, missing };
}

const build = readJson(join(NEXT, "build-manifest.json")) ?? {};
const rootMain = (build.rootMainFiles ?? []).filter(isJs).map(norm);
const routeNames = readJson(join(NEXT, "app-path-routes-manifest.json")) ?? {};
/** "/compose/page" -> "/compose" ; drop non-page entries (route handlers). */
const routeOf = (entry) => routeNames[entry] ?? (entry.replace(/\/page$/, "") || "/");

const perRoute = new Map();
let source;

const appBuild = readJson(join(NEXT, "app-build-manifest.json"));
if (appBuild?.pages) {
  source = "app-build-manifest.json";
  for (const [entry, chunks] of Object.entries(appBuild.pages)) {
    if (!entry.endsWith("/page")) continue;
    perRoute.set(routeOf(entry), new Set([...rootMain, ...chunks.filter(isJs).map(norm)]));
  }
} else {
  source = "client-reference-manifests";
  const appDir = join(NEXT, "server", "app");
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "page_client-reference-manifest.js") files.push(p);
    }
  };
  if (existsSync(appDir)) walk(appDir);
  for (const f of files) {
    const ctx = { globalThis: {} };
    ctx.globalThis = ctx;
    try {
      vm.runInNewContext(readFileSync(f, "utf8"), ctx, { timeout: 5000 });
    } catch (e) {
      console.warn(`bundles: cannot evaluate ${relative(ROOT, f)}: ${e.message}`);
      continue;
    }
    const manifests = ctx.__RSC_MANIFEST ?? {};
    for (const [entry, m] of Object.entries(manifests)) {
      const chunks = new Set(rootMain);
      for (const list of Object.values(m.entryJSFiles ?? {})) for (const c of list) if (isJs(c)) chunks.add(norm(c));
      perRoute.set(routeOf(entry), chunks);
    }
  }
}

if (perRoute.size === 0) {
  console.error("bundles: no route chunk data found (neither app-build-manifest.json nor client reference manifests)");
  process.exit(1);
}

const routes = [...perRoute.entries()]
  .map(([route, set]) => {
    const chunks = [...set];
    const routeOnly = chunks.filter((c) => !rootMain.includes(c));
    return {
      route,
      firstLoad: total(chunks),
      routeSpecific: total(routeOnly),
      chunks: chunks.map((c) => ({ file: c, ...chunkSize(c) })).sort((a, b) => b.gzip - a.gzip).slice(0, 15),
    };
  })
  .sort((a, b) => b.firstLoad.gzip - a.firstLoad.gzip);

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
mkdirSync(OUT, { recursive: true });
const summary = {
  generatedAt: new Date().toISOString(),
  source,
  buildId: existsSync(join(NEXT, "BUILD_ID")) ? readFileSync(join(NEXT, "BUILD_ID"), "utf8").trim() : null,
  shared: total(rootMain),
  routes,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`bundles (${source}): shared root ${kb(summary.shared.gzip)} gzip`);
for (const r of routes.slice(0, 25)) {
  console.log(`  ${r.route.padEnd(32)} first-load ${kb(r.firstLoad.gzip).padStart(11)} gzip  (route-specific ${kb(r.routeSpecific.gzip)})`);
}
console.log(`→ ${relative(ROOT, join(OUT, "summary.json")).split(sep).join("/")} (${routes.length} routes)`);
