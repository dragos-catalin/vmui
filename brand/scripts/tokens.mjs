// Vatra brand tokens: ONE source -> DTCG 2025.10 JSON + contrast pairs + generated CSS for web and desktop.
// node brand/scripts/tokens.mjs
// Primary = ember (oklch h48). Neutrals = warm (h55, from the desktop app). Secondary = indigo h262.
// "Lit / on" state = amber h78. Users can still pick another accent hue in Appearance (--accent-h);
// ember is the default. Every value below that the UI renders as text/UI is in contrast-pairs.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { oklchToHex } from "./mark.mjs";

export const HUE = { ember: 48, neutral: 55, indigo: 262, amber: 78, success: 150, warning: 75, danger: 25, info: 230 };

const o = (L, C, h) => ({ L, C, h });
const css = ({ L, C, h }, a) => `oklch(${L} ${C} ${h}${a == null ? "" : ` / ${a}`})`;

// Theme semantics. The web CSS keeps `var(--accent-h)` for accent-driven tokens; the DTCG files
// store the default (ember) so non-CSS consumers get concrete colours.
export const THEMES = {
  light: {
    bg: o(0.985, 0.006, HUE.neutral), "bg-muted": o(0.962, 0.009, HUE.neutral),
    surface: o(1, 0, 0), "surface-muted": o(0.975, 0.007, HUE.neutral), "surface-2": o(0.948, 0.011, HUE.neutral),
    border: o(0.9, 0.012, HUE.neutral), "border-strong": o(0.62, 0.02, HUE.neutral),
    fg: o(0.2, 0.025, 45), "fg-muted": o(0.45, 0.022, 50), "fg-soft": o(0.52, 0.02, 50),
    primary: o(0.56, 0.16, "A"), "primary-fg": o(0.99, 0.006, 60), "primary-text": o(0.5, 0.15, "A"),
    accent: o(0.5, 0.15, HUE.indigo), "accent-fg": o(0.99, 0.006, HUE.indigo),
    lit: o(0.8, 0.14, HUE.amber), "lit-fg": o(0.22, 0.04, HUE.amber), "lit-text": o(0.5, 0.11, 70),
    success: o(0.5, 0.13, HUE.success), "success-fg": o(0.99, 0.005, HUE.success),
    warning: o(0.8, 0.15, HUE.warning), "warning-fg": o(0.22, 0.04, HUE.warning), "warning-text": o(0.5, 0.11, 65),
    danger: o(0.52, 0.19, HUE.danger), "danger-fg": o(0.99, 0.005, HUE.danger),
    info: o(0.5, 0.13, HUE.info), "info-fg": o(0.99, 0.005, HUE.info),
    ring: o(0.56, 0.16, "A"),
  },
  dark: {
    bg: o(0.155, 0.014, HUE.neutral), "bg-muted": o(0.185, 0.016, HUE.neutral),
    surface: o(0.21, 0.018, HUE.neutral), "surface-muted": o(0.24, 0.018, HUE.neutral), "surface-2": o(0.27, 0.02, HUE.neutral),
    border: o(0.31, 0.018, HUE.neutral), "border-strong": o(0.54, 0.02, HUE.neutral),
    fg: o(0.95, 0.014, 70), "fg-muted": o(0.76, 0.02, 65), "fg-soft": o(0.68, 0.02, 65),
    primary: o(0.7, 0.16, "A"), "primary-fg": o(0.17, 0.03, 45), "primary-text": o(0.76, 0.14, "A"),
    accent: o(0.74, 0.13, HUE.indigo), "accent-fg": o(0.16, 0.03, HUE.indigo),
    lit: o(0.84, 0.13, HUE.amber), "lit-fg": o(0.2, 0.04, HUE.amber), "lit-text": o(0.86, 0.12, HUE.amber),
    success: o(0.8, 0.15, HUE.success), "success-fg": o(0.16, 0.03, HUE.success),
    warning: o(0.82, 0.15, HUE.warning), "warning-fg": o(0.2, 0.04, HUE.warning), "warning-text": o(0.84, 0.14, HUE.warning),
    danger: o(0.7, 0.18, HUE.danger), "danger-fg": o(0.14, 0.03, HUE.danger),
    info: o(0.76, 0.12, HUE.info), "info-fg": o(0.14, 0.03, HUE.info),
    ring: o(0.72, 0.16, "A"),
  },
};

const resolve = (t, accentH = HUE.ember) => ({ ...t, h: t.h === "A" ? accentH : t.h });
const cssVal = (t) => (t.h === "A" ? `oklch(${t.L} ${t.C} var(--accent-h))` : css(t));

export const RADII = { sm: "0.5rem", md: "0.75rem", lg: "1.125rem", xl: "1.5rem" }; // 8/12/18/24 px = desktop scale
export const MOTION = {
  duration: { instant: 80, fast: 140, base: 220, slow: 360, page: 420, splash: 1100 },
  ease: {
    out: [0.16, 1, 0.3, 1], inOut: [0.65, 0, 0.35, 1], emphasized: [0.2, 0, 0, 1],
    spring: { stiffness: 380, damping: 32, mass: 0.9 }, springSoft: { stiffness: 220, damping: 28, mass: 1 },
  },
  logo: { riseMs: 2100, flameMs: 1800, introMs: 1150, stagger: 700 },
};
export const TYPE = {
  sans: '"Inter Variable", "Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif',
  display: '"Inter Tight Variable", "Inter Tight", "Inter Variable", ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "Cascadia Code", SFMono-Regular, Menlo, Consolas, monospace',
};

// ---------- contrast pairs (every shipped fg/bg pairing, both themes) ----------
function pairs() {
  const out = [];
  const add = (theme, name, fg, bg, use) => {
    const T = THEMES[theme];
    out.push({ name: `${theme}: ${name}`, fg: css(resolve(T[fg])), bg: css(resolve(T[bg])), use, fgToken: fg, bgToken: bg });
  };
  for (const th of ["light", "dark"]) {
    for (const bg of ["bg", "bg-muted", "surface", "surface-muted", "surface-2"]) {
      add(th, `fg on ${bg}`, "fg", bg, "body");
      add(th, `fg-muted on ${bg}`, "fg-muted", bg, "body");
    }
    for (const bg of ["bg", "surface"]) {
      add(th, `fg-soft on ${bg}`, "fg-soft", bg, "body");
      add(th, `primary-text on ${bg}`, "primary-text", bg, "body");
      add(th, `lit-text on ${bg}`, "lit-text", bg, "body");
      add(th, `warning-text on ${bg}`, "warning-text", bg, "body");
      add(th, `border-strong on ${bg}`, "border-strong", bg, "ui");
      add(th, `ring on ${bg}`, "ring", bg, "ui");
      add(th, `primary (solid ui) on ${bg}`, "primary", bg, "ui");
      add(th, `danger (ui) on ${bg}`, "danger", bg, "ui");
      add(th, `success (ui) on ${bg}`, "success", bg, "ui");
    }
    for (const s of ["primary", "accent", "lit", "success", "warning", "danger", "info"]) add(th, `${s}-fg on ${s}`, `${s}-fg`, s, "body");
  }
  return out;
}

// ---------- DTCG ----------
const dtcgColor = (t, desc) => {
  const r = resolve(t);
  return { $type: "color", $value: { colorSpace: "oklch", components: [r.L, r.C, r.h], hex: oklchToHex(r.L, r.C, r.h) }, ...(desc ? { $description: desc } : {}) };
};

function build() {
  const semantic = { $description: "Vatra semantic colour tokens. Themes remap only this layer.", color: {} };
  for (const [th, T] of Object.entries(THEMES)) {
    semantic.color[th] = {};
    for (const [k, v] of Object.entries(T)) semantic.color[th][k] = dtcgColor(v, v.h === "A" ? "accent-driven (default ember h48; follows --accent-h)" : undefined);
  }
  const ramp = (h, cMax) => Object.fromEntries(
    [0.985, 0.965, 0.93, 0.89, 0.84, 0.78, 0.7, 0.62, 0.56, 0.5, 0.42, 0.24].map((L, i) => {
      const c = +(cMax * Math.sin(Math.PI * Math.min(1, Math.max(0.08, 1 - Math.abs(L - 0.62) / 0.62)) / 2)).toFixed(3);
      return [String(i + 1), dtcgColor(o(L, c, h))];
    }),
  );
  const primitives = {
    $description: "Vatra primitive ramps (12 steps, Radix jobs). Never used directly by components.",
    color: { ember: ramp(HUE.ember, 0.17), neutral: ramp(HUE.neutral, 0.022), indigo: ramp(HUE.indigo, 0.15), amber: ramp(HUE.amber, 0.15) },
  };
  const motion = {
    duration: Object.fromEntries(Object.entries(MOTION.duration).map(([k, v]) => [k, { $type: "duration", $value: { value: v, unit: "ms" } }])),
    easing: Object.fromEntries(Object.entries(MOTION.ease).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, { $type: "cubicBezier", $value: v }])),
    spring: { default: { $type: "spring", $value: MOTION.ease.spring }, soft: { $type: "spring", $value: MOTION.ease.springSoft } },
    logo: Object.fromEntries(Object.entries(MOTION.logo).map(([k, v]) => [k, { $type: "number", $value: v }])),
  };
  const typography = {
    fontFamily: Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [k, { $type: "fontFamily", $value: v.split(",").map((s) => s.trim().replace(/^"|"$/g, "")) }])),
    radius: Object.fromEntries(Object.entries(RADII).map(([k, v]) => [k, { $type: "dimension", $value: { value: parseFloat(v), unit: "rem" } }])),
  };

  // ---------- generated CSS (consumed by src/app/globals.css and apps/desktop/src/app.css) ----------
  const lines = (T) => Object.entries(T).map(([k, v]) => `  --color-${k}: ${cssVal(v)};`).join("\n");
  const themeCss = `/* GENERATED by brand/scripts/tokens.mjs — do not edit by hand. Vatra brand ${pkg.version}. */
/* Light values live in @theme (Tailwind utilities); .dark remaps the same names. */
@theme {
${lines(THEMES.light)}
  --radius-sm: ${RADII.sm};
  --radius-md: ${RADII.md};
  --radius-lg: ${RADII.lg};
  --radius-xl: ${RADII.xl};
  --duration-instant: ${MOTION.duration.instant}ms;
  --duration-fast: ${MOTION.duration.fast}ms;
  --duration-base: ${MOTION.duration.base}ms;
  --duration-slow: ${MOTION.duration.slow}ms;
  --duration-page: ${MOTION.duration.page}ms;
  --ease-out: cubic-bezier(${MOTION.ease.out.join(", ")});
  --ease-in-out: cubic-bezier(${MOTION.ease.inOut.join(", ")});
  --ease-emphasized: cubic-bezier(${MOTION.ease.emphasized.join(", ")});
}

:root {
  --accent-h: ${HUE.ember};
}

.dark {
${lines(THEMES.dark)}
}
`;
  return { semantic, primitives, motion, typography, themeCss };
}

const pkg = { version: "1.0.0" };

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const b = build();
  mkdirSync("brand/tokens", { recursive: true });
  mkdirSync("brand/dist/css", { recursive: true });
  writeFileSync("brand/tokens/primitives.tokens.json", JSON.stringify(b.primitives, null, 2) + "\n");
  writeFileSync("brand/tokens/semantic.tokens.json", JSON.stringify(b.semantic, null, 2) + "\n");
  writeFileSync("brand/tokens/motion.tokens.json", JSON.stringify(b.motion, null, 2) + "\n");
  writeFileSync("brand/tokens/typography.tokens.json", JSON.stringify(b.typography, null, 2) + "\n");
  writeFileSync("brand/contrast-pairs.json", JSON.stringify({ $description: "Generated by brand/scripts/tokens.mjs. Every shipped fg/bg pairing, both themes, default accent (ember).", pairs: pairs() }, null, 2) + "\n");
  writeFileSync("brand/dist/css/vatra-theme.css", b.themeCss);
  console.log(`tokens ok: ${pairs().length} contrast pairs`);
}
