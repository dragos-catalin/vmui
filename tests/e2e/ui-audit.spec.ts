// UI audit: every page route × locale × theme × width. Records console/page errors,
// hydration warnings, horizontal overflow, clipped text, overlapping text, clipped shadows,
// axe (WCAG 2.2 AA) and a full-page screenshot. An AUDIT: findings never fail the run unless
// UI_AUDIT_STRICT=1 (then serious/critical axe, overflow or clipped text fail the route).
//
// Env: PW_SESSION_FILE (session id file from scripts/e2e-cloud/seed.cjs) or PW_SESSION,
//      UI_AUDIT_WIDTHS (default 360,768,1440,3440), UI_AUDIT_ROUTES (regex on the path),
//      UI_AUDIT_LOCALES (en,ro), UI_AUDIT_THEMES (light,dark), UI_AUDIT_AXE_WIDTHS (default = all),
//      UI_AUDIT_STRICT=1.
// Output: test-results/ui-audit/<route-slug>/<locale>-<theme>-<width>.png,
//         test-results/ui-audit/records/<slug>.json, test-results/ui-audit/summary.json
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type ConsoleMessage } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES, SSE_PATTERN, routeSlug, type AuditRoute } from "./routes";

const OUT = join(process.cwd(), "test-results", "ui-audit");
const RECORDS = join(OUT, "records");
const list = (v: string | undefined, d: string) =>
  (v ?? d)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const WIDTHS = list(process.env.UI_AUDIT_WIDTHS, "360,768,1440,3440").map(Number).filter((n) => n > 0);
const AXE_WIDTHS = new Set(list(process.env.UI_AUDIT_AXE_WIDTHS, WIDTHS.join(",")).map(Number));
const LOCALES = list(process.env.UI_AUDIT_LOCALES, "en,ro");
const THEMES = list(process.env.UI_AUDIT_THEMES, "light,dark") as Array<"light" | "dark">;
const STRICT = process.env.UI_AUDIT_STRICT === "1";
const ROUTE_FILTER = process.env.UI_AUDIT_ROUTES ? new RegExp(process.env.UI_AUDIT_ROUTES) : null;
const SELECTED: AuditRoute[] = ROUTES.filter((r) => !ROUTE_FILTER || ROUTE_FILTER.test(r.path));
const VIEWPORT_HEIGHT = 900;
const SETTLE_MS = 800;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

function readSession(): string | null {
  if (process.env.PW_SESSION) return process.env.PW_SESSION.trim();
  const f = process.env.PW_SESSION_FILE;
  if (f && existsSync(f)) return readFileSync(f, "utf8").trim() || null;
  return null;
}
const SESSION = readSession();

interface DomFindings {
  overflowX: { scrollWidth: number; clientWidth: number } | null;
  clippedText: Array<{ selector: string; text: string; sw: number; cw: number; sh: number; ch: number }>;
  overlaps: Array<{ a: string; b: string; area: number; textA: string; textB: string }>;
  clippedShadows: Array<{ selector: string; ancestor: string; sides: string[] }>;
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

interface Variant {
  locale: string;
  theme: string;
  width: number;
  finalUrl: string;
  status: number | null;
  redirectedToSignIn: boolean;
  navError: string | null;
  consoleErrors: string[];
  pageErrors: string[];
  hydrationWarnings: string[];
  dom: DomFindings | null;
  axe: { serious: number; critical: number; violations: AxeViolation[] } | null;
  screenshot: string | null;
  ms: number;
}

interface RouteRecord {
  path: string;
  slug: string;
  placeholder: boolean;
  public: boolean;
  variants: Variant[];
}

/** Runs inside the page. Must be self-contained (serialised by Playwright). */
function measureDom(): DomFindings {
  const MAX = 40;
  const sel = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 4; i++) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${s}#${cur.id}`);
        break;
      }
      const cls = (cur.getAttribute("class") ?? "").split(/\s+/).filter((c) => c && !c.includes(":")).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (el: Element): boolean => {
    if (el.closest(".sr-only,[aria-hidden='true'],[hidden]")) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const ownText = (el: Element): string => {
    let t = "";
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.textContent ?? "";
    return t.replace(/\s+/g, " ").trim();
  };
  const isClip = (v: string) => v === "hidden" || v === "clip";

  const doc = document.documentElement;
  const overflowX = doc.scrollWidth > doc.clientWidth + 1 ? { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth } : null;

  const all = Array.from(document.body.querySelectorAll("*"));
  const textEls = all.filter((el) => ownText(el).length > 0 && visible(el));

  const clippedText: DomFindings["clippedText"] = [];
  for (const el of textEls) {
    if (clippedText.length >= MAX) break;
    const cs = getComputedStyle(el);
    if (!isClip(cs.overflowX) && !isClip(cs.overflowY)) continue;
    // Deliberate truncation: ellipsis or line clamp.
    if (cs.textOverflow === "ellipsis") continue;
    const clamp = cs.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none") continue;
    const h = el as HTMLElement;
    const wide = isClip(cs.overflowX) && h.scrollWidth > h.clientWidth + 1;
    const tall = isClip(cs.overflowY) && h.scrollHeight > h.clientHeight + 1;
    if (wide || tall) {
      clippedText.push({
        selector: sel(el),
        text: ownText(el).slice(0, 80),
        sw: h.scrollWidth,
        cw: h.clientWidth,
        sh: h.scrollHeight,
        ch: h.clientHeight,
      });
    }
  }

  // Overlap of visible text boxes (sampled). Ignore ancestor/descendant pairs.
  const overlaps: DomFindings["overlaps"] = [];
  // Visible part of an element after every clipping/scrolling ancestor (a nav item scrolled out
  // of a 100dvh sidebar is not "overlapping" the sidebar footer).
  const clipRect = (el: Element): DOMRect | null => {
    let r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const ar = a.getBoundingClientRect();
        left = Math.max(left, ar.left); top = Math.max(top, ar.top);
        right = Math.min(right, ar.right); bottom = Math.min(bottom, ar.bottom);
      }
      if (right - left <= 1 || bottom - top <= 1) return null;
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };
  // Fixed/sticky chrome (mobile bottom nav, topbar) legitimately covers content while it scrolls
  // underneath. It is only a bug when the page cannot scroll the content clear of it — i.e. the
  // document bottom padding is smaller than the fixed bar.
  const pinned = (el: Element): boolean => {
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === "fixed") return true;
      if (p === "sticky") {
        // A sticky table header inside its own scroll box scrolls with the page: not viewport chrome.
        let s = a.parentElement;
        while (s && s !== document.body) {
          const o = getComputedStyle(s);
          if (/(auto|scroll)/.test(o.overflowY + o.overflowX)) break;
          s = s.parentElement;
        }
        if (!s || s === document.body) return true;
      }
    }
    return false;
  };
  const docBottomGap = (() => {
    const main = document.querySelector("main");
    if (!main) return 0;
    return Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
  })();
  const sample = textEls
    .slice(0, 400)
    .map((el) => ({ el, r: clipRect(el), pinned: pinned(el) }))
    .filter((x): x is { el: Element; r: DOMRect; pinned: boolean } => x.r !== null);
  outer: for (let i = 0; i < sample.length; i++) {
    const a = sample[i]!;
    for (let j = i + 1; j < sample.length; j++) {
      const b = sample[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.pinned !== b.pinned) {
        // content vs fixed chrome: fine if the page has room to scroll the content out from under it
        const bar = a.pinned ? a : b;
        if (docBottomGap >= bar.r.height || bar.r.top < innerHeight / 2) continue;
      }
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const hgt = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && hgt > 2 && w * hgt > 16) {
        overlaps.push({
          a: sel(a.el),
          b: sel(b.el),
          area: Math.round(w * hgt),
          textA: ownText(a.el).slice(0, 40),
          textB: ownText(b.el).slice(0, 40),
        });
        if (overlaps.length >= MAX) break outer;
      }
    }
  }

  // Box-shadows cut off by an overflow-hidden ancestor.
  const clippedShadows: DomFindings["clippedShadows"] = [];
  const px = (s: string) => Number.parseFloat(s) || 0;
  for (const el of all) {
    if (clippedShadows.length >= MAX) break;
    const cs = getComputedStyle(el);
    if (!cs.boxShadow || cs.boxShadow === "none" || !visible(el)) continue;
    // Split shadows on commas outside parentheses.
    const shadows = cs.boxShadow.split(/,(?![^(]*\))/).filter((s) => !/\binset\b/.test(s));
    if (!shadows.length) continue;
    let left = 0, right = 0, top = 0, bottom = 0;
    for (const s of shadows) {
      const nums = (s.replace(/(rgba?|oklch|oklab|hsla?|color)\([^)]*\)/g, "").match(/-?[\d.]+px/g) ?? []).map(px);
      const [ox = 0, oy = 0, blur = 0, spread = 0] = nums;
      if (blur === 0 && spread === 0 && ox === 0 && oy === 0) continue;
      const ext = blur + spread;
      left = Math.max(left, ext - ox);
      right = Math.max(right, ext + ox);
      top = Math.max(top, ext - oy);
      bottom = Math.max(bottom, ext + oy);
    }
    if (!left && !right && !top && !bottom) continue;
    let anc = el.parentElement;
    while (anc && anc !== document.body) {
      const acs = getComputedStyle(anc);
      if (isClip(acs.overflowX) || isClip(acs.overflowY) || isClip(acs.overflow)) break;
      anc = anc.parentElement;
    }
    if (!anc || anc === document.body) continue;
    const r = el.getBoundingClientRect();
    const ar = anc.getBoundingClientRect();
    // Only judge elements that sit inside the clipping ancestor (scrolled-out rows are not this bug).
    if (r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1) continue;
    const sides: string[] = [];
    if (r.left - left < ar.left - 1) sides.push("left");
    if (r.right + right > ar.right + 1) sides.push("right");
    if (r.top - top < ar.top - 1) sides.push("top");
    if (r.bottom + bottom > ar.bottom + 1) sides.push("bottom");
    if (sides.length) clippedShadows.push({ selector: sel(el), ancestor: sel(anc), sides });
  }

  return { overflowX, clippedText, overlaps, clippedShadows };
}

async function auditVariant(
  browser: Browser,
  baseURL: string,
  route: AuditRoute,
  locale: string,
  theme: "light" | "dark",
  width: number,
): Promise<Variant> {
  const t0 = Date.now();
  const url = new URL(baseURL);
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height: VIEWPORT_HEIGHT },
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: locale === "ro" ? "ro-RO" : "en-US",
  });
  const cookieBase = { domain: url.hostname, path: "/", sameSite: "Lax" as const };
  await context.addCookies([
    { ...cookieBase, name: "vmui_locale", value: locale },
    { ...cookieBase, name: "vmui_appearance", value: encodeURIComponent(JSON.stringify({ theme })) },
    ...(SESSION ? [{ ...cookieBase, name: "vmui_session", value: SESSION, httpOnly: true }] : []),
  ]);
  await context.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem("theme", t);
        localStorage.setItem("vmui:appearance", JSON.stringify({ theme: t }));
      } catch {
        /* storage blocked */
      }
    },
    [theme] as const,
  );
  await context.route(SSE_PATTERN, (r) => r.abort());

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const hydrationWarnings: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    const text = m.text();
    const loc = m.location()?.url ?? "";
    if (/hydrat|did not match|server rendered|text content does not match/i.test(text)) {
      hydrationWarnings.push(text.slice(0, 500));
      return;
    }
    if (m.type() !== "error") return;
    // Our own aborts of SSE endpoints are expected noise.
    if (SSE_PATTERN.test(loc) || /EventSource/i.test(text)) return;
    consoleErrors.push(`${text.slice(0, 400)}${loc ? ` @ ${loc}` : ""}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`.slice(0, 500)));

  const v: Variant = {
    locale,
    theme,
    width,
    finalUrl: "",
    status: null,
    redirectedToSignIn: false,
    navError: null,
    consoleErrors,
    pageErrors,
    hydrationWarnings,
    dom: null,
    axe: null,
    screenshot: null,
    ms: 0,
  };
  try {
    const resp = await page.goto(route.path, { waitUntil: "load", timeout: 45_000 });
    v.status = resp?.status() ?? null;
    await page.waitForTimeout(SETTLE_MS);
    v.finalUrl = page.url();
    v.redirectedToSignIn = !route.public && new URL(v.finalUrl).pathname === "/sign-in";
    v.dom = await page.evaluate(measureDom);
    if (AXE_WIDTHS.has(width)) {
      const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      const violations: AxeViolation[] = res.violations.map((x) => ({
        id: x.id,
        impact: x.impact ?? null,
        help: x.help,
        nodes: x.nodes.length,
        targets: x.nodes.slice(0, 5).map((n) => n.target.join(" ")),
      }));
      v.axe = {
        serious: violations.filter((x) => x.impact === "serious").length,
        critical: violations.filter((x) => x.impact === "critical").length,
        violations,
      };
    }
    const dir = join(OUT, routeSlug(route.path));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${locale}-${theme}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled", timeout: 60_000 });
    v.screenshot = file.slice(process.cwd().length + 1).replace(/\\/g, "/");
  } catch (e) {
    v.navError = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 400) : String(e);
  } finally {
    v.ms = Date.now() - t0;
    await context.close();
  }
  return v;
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/** Aggregate every record present. Called after each route: the last route to finish sees them all. */
function writeSummary() {
  if (!existsSync(RECORDS)) return;
  const recs: RouteRecord[] = [];
  for (const f of readdirSync(RECORDS)) {
    if (!f.endsWith(".json")) continue;
    try {
      recs.push(JSON.parse(readFileSync(join(RECORDS, f), "utf8")) as RouteRecord);
    } catch {
      /* half-written by another worker; the next call picks it up */
    }
  }
  recs.sort((a, b) => a.path.localeCompare(b.path));
  const totals = {
    routes: recs.length,
    expectedRoutes: SELECTED.length,
    complete: recs.length >= SELECTED.length,
    variants: 0,
    navErrors: 0,
    redirectedToSignIn: 0,
    consoleErrors: 0,
    pageErrors: 0,
    hydrationWarnings: 0,
    overflowX: 0,
    clippedText: 0,
    overlaps: 0,
    clippedShadows: 0,
    axeSerious: 0,
    axeCritical: 0,
  };
  const axeById: Record<string, { impact: string | null; help: string; variants: number; nodes: number }> = {};
  const routes = recs.map((r) => {
    const sum = { navErrors: 0, consoleErrors: 0, pageErrors: 0, hydration: 0, overflowX: 0, clippedText: 0, overlaps: 0, clippedShadows: 0, axeSerious: 0, axeCritical: 0 };
    for (const v of r.variants) {
      totals.variants++;
      if (v.navError) sum.navErrors++;
      if (v.redirectedToSignIn) totals.redirectedToSignIn++;
      sum.consoleErrors += v.consoleErrors.length;
      sum.pageErrors += v.pageErrors.length;
      sum.hydration += v.hydrationWarnings.length;
      if (v.dom?.overflowX) sum.overflowX++;
      sum.clippedText += v.dom?.clippedText.length ?? 0;
      sum.overlaps += v.dom?.overlaps.length ?? 0;
      sum.clippedShadows += v.dom?.clippedShadows.length ?? 0;
      sum.axeSerious += v.axe?.serious ?? 0;
      sum.axeCritical += v.axe?.critical ?? 0;
      for (const x of v.axe?.violations ?? []) {
        const e = (axeById[x.id] ??= { impact: x.impact, help: x.help, variants: 0, nodes: 0 });
        e.variants++;
        e.nodes += x.nodes;
      }
    }
    totals.navErrors += sum.navErrors;
    totals.consoleErrors += sum.consoleErrors;
    totals.pageErrors += sum.pageErrors;
    totals.hydrationWarnings += sum.hydration;
    totals.overflowX += sum.overflowX;
    totals.clippedText += sum.clippedText;
    totals.overlaps += sum.overlaps;
    totals.clippedShadows += sum.clippedShadows;
    totals.axeSerious += sum.axeSerious;
    totals.axeCritical += sum.axeCritical;
    return { path: r.path, slug: r.slug, placeholder: r.placeholder, public: r.public, ...sum };
  });
  writeAtomic(join(OUT, "summary.json"), {
    generatedAt: new Date().toISOString(),
    config: { widths: WIDTHS, axeWidths: [...AXE_WIDTHS], locales: LOCALES, themes: THEMES, strict: STRICT, authenticated: Boolean(SESSION) },
    totals,
    axeById,
    routes,
  });
}

test.describe.configure({ mode: "parallel" });

test.beforeAll(() => {
  mkdirSync(RECORDS, { recursive: true });
});

for (const route of SELECTED) {
  test(`ui-audit ${route.path}`, async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const base = baseURL ?? process.env.PW_BASE_URL ?? "http://127.0.0.1:3737";
    const variants: Variant[] = [];
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          variants.push(await auditVariant(browser, base, route, locale, theme, width));
        }
      }
    }
    const rec: RouteRecord = {
      path: route.path,
      slug: routeSlug(route.path),
      placeholder: Boolean(route.placeholder),
      public: Boolean(route.public),
      variants,
    };
    mkdirSync(RECORDS, { recursive: true });
    writeAtomic(join(RECORDS, `${rec.slug}.json`), rec);
    writeSummary();

    if (STRICT) {
      const bad = variants.filter(
        (v) => (v.axe && v.axe.serious + v.axe.critical > 0) || v.dom?.overflowX || (v.dom?.clippedText.length ?? 0) > 0,
      );
      expect(
        bad.map((v) => `${v.locale}-${v.theme}-${v.width}`),
        `serious/critical axe, horizontal overflow or clipped text on ${route.path}`,
      ).toEqual([]);
    }
  });
}

test.afterAll(() => {
  writeSummary();
});
