import { TURZX_BG_SOURCES } from "@/lib/turzx/catalog";
import { z } from "zod";

// The Google Nest Hub (1024×600 touch) in the bedroom, driven as a web kiosk:
// /display?k=… is cast to it with DashCast (catt on homepi). Same table as
// the Turzx desk screen, row id=4, so /home edits land on the Hub within a poll.

export const DISPLAY_VIEW_IDS = ["clock", "home", "media", "photo", "nutrition", "pc", "pi", "calendar", "fx", "crypto", "weather"] as const;
export type DisplayViewId = (typeof DISPLAY_VIEW_IDS)[number];

export const DISPLAY_VIEW_META: Record<DisplayViewId, { defaultDwell: number; needsTurzx?: string[] }> = {
  clock: { defaultDwell: 30 },
  weather: { defaultDwell: 20, needsTurzx: ["weather"] },
  home: { defaultDwell: 15 },
  media: { defaultDwell: 20 },
  photo: { defaultDwell: 40 },
  nutrition: { defaultDwell: 15, needsTurzx: ["nutrition"] },
  pc: { defaultDwell: 12 },
  pi: { defaultDwell: 12 },
  calendar: { defaultDwell: 15, needsTurzx: ["calendar"] },
  fx: { defaultDwell: 12, needsTurzx: ["fx"] },
  crypto: { defaultDwell: 12, needsTurzx: ["crypto"] },
};

export const displayViewSchema = z.object({
  id: z.enum(DISPLAY_VIEW_IDS),
  enabled: z.boolean(),
  dwellSec: z.number().min(5).max(600),
  /** Photo behind the panel; false = flat night gradient. */
  photo: z.boolean().default(true),
});
export type DisplayView = z.infer<typeof displayViewSchema>;

export const displaySettingsSchema = z.object({
  version: z.literal(1),
  views: z.array(displayViewSchema).min(1),
  /** Photo sources for the slideshow (shared fetchers with Turzx). */
  photoSources: z.array(z.enum(TURZX_BG_SOURCES)).default(["apod", "met", "artic", "commons"]),
  /** Seconds each photo stays before the crossfade (Ken Burns runs across it). */
  photoSec: z.number().min(10).max(600).default(45),
  /** 0..0.9 dark veil over photos so panels stay readable. */
  dim: z.number().min(0).max(0.9).default(0.35),
  nightFrom: z.string().regex(/^\d{2}:\d{2}$/).default("23:00"),
  nightTo: z.string().regex(/^\d{2}:\d{2}$/).default("07:30"),
  /** 0..1 multiplier applied to everything at night (the Hub has no API for backlight). */
  nightDim: z.number().min(0.05).max(1).default(0.35),
  /** Seconds of no touch before the home screen returns to the idle slideshow. */
  idleAfterSec: z.number().min(10).max(600).default(45),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f2b85a"),
  /** Tick sound + short vibration on kiosk taps. */
  tapFeedback: z.boolean().default(false),
  /** Cast target and whether vmui keeps re-casting when the Hub drops it. */
  cast: z.object({
    device: z.string().default("Bedroom Smart Display"),
    keepAlive: z.boolean().default(true),
    /** Don't recast while something else plays on the Hub (YouTube, Spotify…). */
    respectPlayback: z.boolean().default(true),
  }).default({ device: "Bedroom Smart Display", keepAlive: true, respectPlayback: true }),
});
export type DisplaySettings = z.infer<typeof displaySettingsSchema>;

const DEFAULT_ON = new Set<DisplayViewId>(["clock", "home", "media", "photo", "nutrition", "pc", "pi"]);

export const DISPLAY_DEFAULTS: DisplaySettings = {
  version: 1,
  views: DISPLAY_VIEW_IDS.map((id) => ({ id, enabled: DEFAULT_ON.has(id), dwellSec: DISPLAY_VIEW_META[id].defaultDwell, photo: id !== "media" })),
  photoSources: ["apod", "met", "artic", "commons"],
  photoSec: 45,
  dim: 0.35,
  nightFrom: "23:00",
  nightTo: "07:30",
  nightDim: 0.35,
  idleAfterSec: 45,
  accent: "#f2b85a",
  tapFeedback: false,
  cast: { device: "Bedroom Smart Display", keepAlive: true, respectPlayback: true },
};
