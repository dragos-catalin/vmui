// Appearance model shared by server (cookie/DB) and client (provider, switchers).
// Three orthogonal axes + a preset layer:
//   theme    light | dark | system            -> next-themes (`.dark` class)
//   accent   a hue on the oklch wheel          -> [data-accent] + --accent-h
//   surface  glass | flat | contrast           -> [data-surface]
//   density  comfortable | compact             -> [data-density]
//   vibe     preset that sets accent + surface + atmosphere in one click -> [data-vibe]
// Nothing here imports React or Node APIs so it is safe in both bundles.

import { z } from "zod";

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const ACCENTS = ["ember", "indigo", "violet", "rose", "orange", "amber", "emerald", "teal", "sky", "custom"] as const;
export type Accent = (typeof ACCENTS)[number];
/** Hue (oklch, degrees) for each preset; `custom` uses `accentHue`. */
export const ACCENT_HUE: Record<Exclude<Accent, "custom">, number> = {
  ember: 48,
  indigo: 265,
  violet: 300,
  rose: 350,
  orange: 60,
  amber: 75,
  emerald: 150,
  teal: 185,
  sky: 230,
};

export const SURFACES = ["glass", "flat", "contrast"] as const;
export type Surface = (typeof SURFACES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const VIBES = ["default", "cyberpunk", "cockpit", "strategy", "terminal", "minimal", "aurora", "synthwave"] as const;
export type Vibe = (typeof VIBES)[number];

export const appearanceSchema = z.object({
  theme: z.enum(THEMES).default("system"),
  accent: z.enum(ACCENTS).default("ember"),
  /** 0–360, only read when accent === "custom". */
  accentHue: z.number().min(0).max(360).default(48),
  surface: z.enum(SURFACES).default("glass"),
  density: z.enum(DENSITIES).default("comfortable"),
  vibe: z.enum(VIBES).default("default"),
  /** Overrides the OS setting when set; null = follow `prefers-reduced-motion`. */
  reducedMotion: z.boolean().nullable().default(null),
  /** Opt-in: neutrals warm up when house lights are on or after sunset ([data-ambient="warm"]). */
  ambient: z.boolean().default(false),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const APPEARANCE_DEFAULTS: Appearance = appearanceSchema.parse({});

/** One cookie carries the whole object so the server can render the right attributes on first paint. */
export const APPEARANCE_COOKIE = "vmui_appearance";
export const APPEARANCE_STORAGE_KEY = "vmui:appearance";

export function parseAppearance(raw: unknown): Appearance {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return APPEARANCE_DEFAULTS;
    }
  }
  const p = appearanceSchema.safeParse(raw ?? {});
  return p.success ? p.data : APPEARANCE_DEFAULTS;
}

export function accentHueOf(a: Pick<Appearance, "accent" | "accentHue">): number {
  return a.accent === "custom" ? a.accentHue : ACCENT_HUE[a.accent];
}

/** Attributes to put on <html>. The provider and the SSR layout both use this so they never disagree. */
export function appearanceAttributes(a: Appearance): Record<string, string> {
  return {
    "data-accent": a.accent,
    "data-surface": a.surface,
    "data-density": a.density,
    "data-vibe": a.vibe,
    ...(a.reducedMotion === null ? {} : { "data-motion": a.reducedMotion ? "reduce" : "full" }),
    ...(a.ambient ? { "data-ambient": "auto" } : {}),
    style: `--accent-h:${accentHueOf(a)}`,
  };
}

/** Vibes are presets: picking one also sets accent + surface so the three switchers stay coherent. */
export const VIBE_PRESET: Record<Vibe, Partial<Pick<Appearance, "accent" | "surface">>> = {
  default: { accent: "ember", surface: "glass" },
  cyberpunk: { accent: "rose", surface: "glass" },
  cockpit: { accent: "amber", surface: "flat" },
  strategy: { accent: "amber", surface: "glass" },
  terminal: { accent: "emerald", surface: "flat" },
  minimal: { accent: "indigo", surface: "flat" },
  aurora: { accent: "teal", surface: "glass" },
  synthwave: { accent: "rose", surface: "glass" },
};
