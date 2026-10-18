#!/usr/bin/env node
// Lighthouse lab run against a running vmui (cloud e2e VM: PW_BASE_URL + PW_SESSION_FILE).
// Uses the global `lighthouse` binary (baked into the vmui-e2e-runner image) with
// CHROME_PATH = Playwright's chromium. Output: test-results/lighthouse/<slug>-<preset>.{report.json,report.html}
// and test-results/lighthouse/summary.json.
//
//   node tests/e2e/lighthouse.mjs                 all routes × mobile+desktop
//   LH_ROUTES=/,/home LH_PRESETS=desktop node tests/e2e/lighthouse.mjs
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const BASE = (process.env.PW_BASE_URL ?? "http://127.0.0.1:3737").replace(/\/$/, "");
const OUT = join(process.cwd(), "test-results", "lighthouse");
const ROUTES = (process.env.LH_ROUTES ?? "/,/home,/instances,/settings,/sign-in,/display,/monitoring")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PRESETS = (process.env.LH_PRESETS ?? "mobile,desktop").split(",").map((s) => s.trim()).filter(Boolean);
const LOCALE = process.env.LH_LOCALE ?? "en";

function session() {
  if (process.env.PW_SESSION) return process.env.PW_SESSION.trim();
  const f = process.env.PW_SESSION_FILE;
  return f && existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { chromium } = require("@playwright/test");
  return chromium.executablePath();
}

const slug = (p) => (p === "/" ? "root" : p.replace(/^\//, "").replace(/[^a-zA-Z0-9-]+/g, "_"));

mkdirSync(OUT, { recursive: true });
const sid = session();
const headersFile = join(tmpdir(), `vmui-lh-headers-${process.pid}.json`);
const cookie = [`vmui_locale=${LOCALE}`, sid ? `vmui_session=${sid}` : ""].filter(Boolean).join("; ");
writeFileSync(headersFile, JSON.stringify({ Cookie: cookie }), { mode: 0o600 });
const env = { ...process.env, CHROME_PATH: chromePath() };
const bin = process.env.LIGHTHOUSE_BIN ?? "lighthouse";

const audit = (lhr, id) => lhr.audits?.[id];
const num = (lhr, id) => {
  const v = audit(lhr, id)?.numericValue;
  return typeof v === "number" ? Math.round(v * 1000) / 1000 : null;
};

function jsBytes(lhr) {
  const items = audit(lhr, "network-requests")?.details?.items ?? [];
  let transfer = 0;
  let resource = 0;
  for (const it of items) {
    if (it.resourceType !== "Script") continue;
    transfer += it.transferSize ?? 0;
    resource += it.resourceSize ?? 0;
  }
  return { transfer, resource };
}

const results = [];
let failures = 0;
try {
  for (const route of ROUTES) {
    for (const preset of PRESETS) {
      const base = join(OUT, `${slug(route)}-${preset}`);
      const args = [
        `${BASE}${route}`,
        "--quiet",
        "--output=json",
        "--output=html",
        `--output-path=${base}`,
        `--extra-headers=${headersFile}`,
        "--only-categories=performance,accessibility,best-practices,seo",
        "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
        "--max-wait-for-load=45000",
        // Long-lived SSE streams keep the network busy forever, so Lighthouse never sees
        // "network idle" and times out. The UI audit aborts the same endpoints.
        "--blocked-url-patterns=*/api/events*",
        "--blocked-url-patterns=*/api/notify/stream*",
        "--blocked-url-patterns=*/api/home/events*",
        "--blocked-url-patterns=*/stream",
        "--blocked-url-patterns=*/stream?*",
        "--blocked-url-patterns=*/probe-stream*",
      ];
      if (preset === "desktop") args.push("--preset=desktop");
      const t0 = Date.now();
      const r = spawnSync(bin, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
      const jsonFile = `${base}.report.json`;
      if (r.status !== 0 || !existsSync(jsonFile)) {
        failures++;
        const err = (r.stderr || r.error?.message || "").split("\n").slice(-5).join(" | ");
        console.error(`✗ ${route} ${preset}: lighthouse exit ${r.status} ${err}`);
        results.push({ route, preset, error: `exit ${r.status}: ${err.slice(0, 400)}` });
        continue;
      }
      const lhr = JSON.parse(readFileSync(jsonFile, "utf8"));
      const score = (c) => (lhr.categories?.[c]?.score == null ? null : Math.round(lhr.categories[c].score * 100));
      const row = {
        route,
        preset,
        finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
        redirectedToSignIn: route !== "/sign-in" && /\/sign-in(\?|$)/.test(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? ""),
        performance: score("performance"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        seo: score("seo"),
        lcpMs: num(lhr, "largest-contentful-paint"),
        fcpMs: num(lhr, "first-contentful-paint"),
        cls: num(lhr, "cumulative-layout-shift"),
        tbtMs: num(lhr, "total-blocking-time"),
        inpMs: num(lhr, "interaction-to-next-paint") ?? num(lhr, "experimental-interaction-to-next-paint"),
        ttiMs: num(lhr, "interactive"),
        speedIndexMs: num(lhr, "speed-index"),
        totalByteWeight: num(lhr, "total-byte-weight"),
        js: jsBytes(lhr),
        report: `${base.slice(process.cwd().length + 1).replace(/\\/g, "/")}.report.html`,
        seconds: Math.round((Date.now() - t0) / 1000),
      };
      results.push(row);
      console.log(
        `${route.padEnd(12)} ${preset.padEnd(7)} perf=${row.performance} lcp=${row.lcpMs}ms cls=${row.cls} tbt=${row.tbtMs}ms js=${Math.round(row.js.transfer / 1024)}KiB`,
      );
    }
  }
} finally {
  rmSync(headersFile, { force: true });
}

writeFileSync(
  join(OUT, "summary.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, locale: LOCALE, authenticated: Boolean(sid), results }, null, 2),
);
console.log(`lighthouse: ${results.length - failures}/${results.length} ok → ${join(OUT, "summary.json")}`);
// An audit: failures are reported, not fatal, unless LH_STRICT=1.
process.exit(process.env.LH_STRICT === "1" && failures > 0 ? 1 : 0);
