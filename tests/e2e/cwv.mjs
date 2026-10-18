#!/usr/bin/env node
// Core Web Vitals per route, measured in Playwright Chromium (runs on the cloud e2e VM):
//   LCP + CLS + FCP + TTFB from PerformanceObserver (buffered), INP from the Event Timing API after
//   real interactions (click the first enabled button/link/tab in <main>, press Tab, type in the first
//   input), JS bytes transferred. Two profiles: mobile (Moto G Power-ish: 390x844, 4x CPU slowdown,
//   Slow 4G 150 ms RTT / 1.6 Mbps) and desktop (1440x900, no throttling). 3 runs each, median reported.
// Env: PW_BASE_URL, PW_SESSION_FILE, CWV_ROUTES (comma list), CWV_RUNS (default 3), LOCALE (en).
// Output: test-results/cwv/summary.json
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.PW_BASE_URL ?? "http://127.0.0.1:3737").replace(/\/$/, "");
const OUT = join(process.cwd(), "test-results/cwv");
const ROUTES = (process.env.CWV_ROUTES ?? "/,/home,/instances,/settings,/sign-in,/monitoring,/costs,/activity").split(",").map((s) => s.trim()).filter(Boolean);
const RUNS = Number(process.env.CWV_RUNS ?? 3);
const LOCALE = process.env.LOCALE ?? "en";
const sid = process.env.PW_SESSION_FILE && existsSync(process.env.PW_SESSION_FILE) ? readFileSync(process.env.PW_SESSION_FILE, "utf8").trim() : "";
const SSE = /\/api\/(events|notify\/stream|home\/events)(\?|$)|\/(stream|probe-stream)(\?|$)/;

const PROFILES = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpu: 4, net: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpu: 1, net: null },
};

const OBSERVE = () => {
  const w = window;
  w.__cwv = { lcp: 0, cls: 0, fcp: 0, inp: 0, events: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__cwv.lcp = Math.max(w.__cwv.lcp, e.renderTime || e.loadTime || e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
  // CLS: session windows (max 5 s, gap 1 s), report the worst window like web-vitals.
  let win = 0, winStart = 0, last = 0;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      if (e.startTime - last > 1000 || e.startTime - winStart > 5000) { win = 0; winStart = e.startTime; }
      win += e.value; last = e.startTime;
      w.__cwv.cls = Math.max(w.__cwv.cls, win);
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") w.__cwv.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.interactionId) { w.__cwv.events.push(e.duration); w.__cwv.inp = Math.max(w.__cwv.inp, e.duration); }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
};

const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function measure(browser, route, name) {
  const p = PROFILES[name];
  const ctx = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile, hasTouch: p.hasTouch, locale: LOCALE === "ro" ? "ro-RO" : "en-US", reducedMotion: "no-preference" });
  const host = new URL(BASE).hostname;
  await ctx.addCookies([{ name: "vmui_locale", value: LOCALE, domain: host, path: "/" }, ...(sid ? [{ name: "vmui_session", value: sid, domain: host, path: "/", httpOnly: true }] : [])]);
  await ctx.addInitScript(OBSERVE);
  await ctx.route(SSE, (r) => r.abort());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (p.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  if (p.net) { await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, ...p.net }); }
  let js = 0;
  page.on("response", async (r) => { if (r.request().resourceType() === "script") { const len = Number(r.headers()["content-length"] ?? 0); js += len; } });
  const t0 = Date.now();
  const resp = await page.goto(BASE + route, { waitUntil: "load", timeout: 90_000 });
  await page.waitForTimeout(2500);
  const ttfb = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? n.responseStart : null; });
  // Interactions for INP: a click on a safe control, a Tab, a keystroke in a text input (no submit).
  const safe = page.locator("main [role=tab], main button[aria-expanded], main summary, main [data-slot=trigger], main button:not([type=submit])").first();
  try { if (await safe.count()) await safe.click({ timeout: 3000, trial: false }); } catch { /* not clickable */ }
  await page.keyboard.press("Tab");
  const input = page.locator("main input[type=text], main input[type=search], main input:not([type])").first();
  try { if (await input.count()) await input.type("ab", { delay: 60, timeout: 3000 }); } catch { /* none */ }
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => window.__cwv);
  await ctx.close();
  return { status: resp?.status() ?? null, lcp: Math.round(m.lcp), cls: Math.round(m.cls * 1000) / 1000, fcp: Math.round(m.fcp), inp: m.events.length ? Math.round(m.inp) : null, ttfb: ttfb == null ? null : Math.round(ttfb), jsBytesHeader: js, wallMs: Date.now() - t0 };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
for (const route of ROUTES) {
  for (const name of Object.keys(PROFILES)) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      try { runs.push(await measure(browser, route, name)); } catch (e) { runs.push({ error: String(e).slice(0, 200) }); }
    }
    const ok = runs.filter((r) => !r.error);
    const row = { route, profile: name, runs: ok.length, lcp: median(ok.map((r) => r.lcp)), cls: median(ok.map((r) => r.cls)), inp: median(ok.map((r) => r.inp)), fcp: median(ok.map((r) => r.fcp)), ttfb: median(ok.map((r) => r.ttfb)), errors: runs.filter((r) => r.error).map((r) => r.error) };
    row.pass = row.lcp != null && row.lcp < 2500 && row.cls != null && row.cls < 0.1 && (row.inp == null || row.inp < 200);
    results.push(row);
    console.log(`${route.padEnd(12)} ${name.padEnd(7)} lcp=${row.lcp} cls=${row.cls} inp=${row.inp} fcp=${row.fcp} ttfb=${row.ttfb} ${row.pass ? "PASS" : "FAIL"} ${row.errors.length ? row.errors[0] : ""}`);
  }
}
await browser.close();
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, runsPerProfile: RUNS, profiles: PROFILES, results }, null, 2));
console.log(`cwv: ${results.filter((r) => r.pass).length}/${results.length} pass → ${join(OUT, "summary.json")}`);
