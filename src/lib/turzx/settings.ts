import { db } from "@/lib/db";
import { turzxSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import "server-only";
import { z } from "zod";
import { NOTIFY_APPS, TURZX_BG_SOURCES, TURZX_SKINS, TURZX_VIEW_IDS, TURZX_VIEW_META } from "./catalog";

// The Turzx 3.5" USB screen on the desk. The Python renderer (turzx/turzx.py)
// pulls this every few seconds, so a change in /home lands on the screen
// without a restart.

export const MIN_DWELL = 5;

export const turzxBackgroundSchema = z.object({
  mode: z.enum(["none", "photo"]),
  sources: z.array(z.enum(TURZX_BG_SOURCES)).default([]),
  folder: z.string().default(""),
  /** 0..1 darkening so text stays readable over any photo. */
  dim: z.number().min(0).max(0.9).default(0.45),
  blur: z.number().min(0).max(12).default(0),
});
export type TurzxBackground = z.infer<typeof turzxBackgroundSchema>;

export const turzxViewConfigSchema = z.object({
  id: z.enum(TURZX_VIEW_IDS),
  enabled: z.boolean(),
  dwellSec: z.number().min(MIN_DWELL).max(300),
  skin: z.enum(TURZX_SKINS),
  /** `null` = inherit the global background. */
  background: turzxBackgroundSchema.nullable().default(null),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type TurzxViewConfig = z.infer<typeof turzxViewConfigSchema>;

/** Phone-notification overlay: shown for a few seconds when the presence
 *  sensor says someone is at the desk. Package allow-list mirrors the
 *  Companion app's "Last notification" sensor. */
export const turzxNotifySchema = z.object({
  enabled: z.boolean().default(true),
  /** Only pop while `home.presence` (a desk presence sensor) is not "off"; no sensor wired = always present. */
  presenceOnly: z.boolean().default(true),
  durationSec: z.number().min(2).max(30).default(6),
  /** Show message body; off = app + sender only. */
  showText: z.boolean().default(true),
  position: z.enum(["top", "center", "bottom"]).default("top"),
  /** Android package names. */
  packages: z.array(z.string()).default([]),
});
export type TurzxNotify = z.infer<typeof turzxNotifySchema>;

export const turzxSettingsSchema = z.object({
  version: z.literal(2),
  views: z.array(turzxViewConfigSchema).min(1),
  fps: z.number().min(5).max(30),
  transitionMs: z.number().min(0).max(2000),
  brightness: z.number().min(5).max(100),
  nightBrightness: z.number().min(0).max(100),
  nightFrom: z.string().regex(/^\d{2}:\d{2}$/),
  nightTo: z.string().regex(/^\d{2}:\d{2}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Rotate 180° for a screen whose cable exits on the other side. */
  flip: z.boolean().default(false),
  background: turzxBackgroundSchema,
  /** Minutes between background changes when a view has a photo background. */
  bgRotateMin: z.number().min(1).max(1440).default(30),
  notify: turzxNotifySchema.default({ enabled: true, presenceOnly: true, durationSec: 6, showText: true, position: "top", packages: NOTIFY_APPS.slice(0, 10).map((a) => a.pkg) }),
});
export type TurzxSettings = z.infer<typeof turzxSettingsSchema>;

const DEFAULT_ENABLED = new Set(["clock", "weather", "home", "ambilight", "pc", "pi", "activity", "media", "lists", "fx", "crypto", "photo", "fleet", "climate"]);

function defaultView(id: TurzxViewConfig["id"], enabled: boolean): TurzxViewConfig {
  const m = TURZX_VIEW_META[id];
  return { id, enabled, dwellSec: m.defaultDwell, skin: m.skins[0] ?? "minimal", background: null, options: {} };
}

export const TURZX_DEFAULTS: TurzxSettings = {
  version: 2,
  views: TURZX_VIEW_IDS.map((id) => defaultView(id, DEFAULT_ENABLED.has(id))),
  fps: 20,
  transitionMs: 600,
  brightness: 60,
  nightBrightness: 15,
  nightFrom: "23:00",
  nightTo: "07:30",
  accent: "#7c9cff",
  flip: false,
  background: { mode: "none", sources: ["apod", "met", "artic"], folder: "", dim: 0.45, blur: 0 },
  bgRotateMin: 30,
  notify: { enabled: true, presenceOnly: true, durationSec: 6, showText: true, position: "top", packages: NOTIFY_APPS.slice(0, 10).map((a) => a.pkg) },
};

/** Any view added to the catalog after the row was saved shows up disabled. */
function withNewViews(s: TurzxSettings): TurzxSettings {
  const have = new Set(s.views.map((v) => v.id));
  const missing = TURZX_VIEW_IDS.filter((id) => !have.has(id)).map((id) => defaultView(id, false));
  return missing.length ? { ...s, views: [...s.views, ...missing] } : s;
}

export async function loadTurzxSettings(): Promise<TurzxSettings> {
  const row = await db.select().from(turzxSettings).where(eq(turzxSettings.id, 1)).get();
  if (!row) return TURZX_DEFAULTS;
  const parsed = turzxSettingsSchema.safeParse(JSON.parse(row.json));
  return parsed.success ? withNewViews(parsed.data) : TURZX_DEFAULTS;
}

export async function saveTurzxSettings(s: TurzxSettings): Promise<void> {
  const json = JSON.stringify(s);
  await db.insert(turzxSettings).values({ id: 1, json }).onConflictDoUpdate({ target: turzxSettings.id, set: { json, updatedAt: new Date() } });
}

// Pomodoro state is runtime, not preference: same table, row id=2.
export const pomodoroSchema = z.object({
  phase: z.enum(["idle", "work", "break"]),
  endsAt: z.number(),
  startedAt: z.number(),
  round: z.number(),
});
export type Pomodoro = z.infer<typeof pomodoroSchema>;
export const POMODORO_IDLE: Pomodoro = { phase: "idle", endsAt: 0, startedAt: 0, round: 0 };

export async function loadPomodoro(): Promise<Pomodoro> {
  const row = await db.select().from(turzxSettings).where(eq(turzxSettings.id, 2)).get();
  if (!row) return POMODORO_IDLE;
  const p = pomodoroSchema.safeParse(JSON.parse(row.json));
  return p.success ? p.data : POMODORO_IDLE;
}

export async function savePomodoro(p: Pomodoro): Promise<void> {
  const json = JSON.stringify(p);
  await db.insert(turzxSettings).values({ id: 2, json }).onConflictDoUpdate({ target: turzxSettings.id, set: { json, updatedAt: new Date() } });
}
