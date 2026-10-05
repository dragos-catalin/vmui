import { LOCALES } from "@/i18n/config";
import { db } from "@/lib/db";
import { turzxSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import "server-only";
import { z } from "zod";

const ROW_ID = 6;
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

// Human labels live in messages/notify `kinds.<id>`; this is colour + icon only.
export const KIND_META = {
  copilot: { color: "#6366f1", icon: "bot" },
  agents: { color: "#6366f1", icon: "bot" },
  intercom: { color: "#ff5a1f", icon: "bell-ring" },
  pairing: { color: "#22c55e", icon: "smartphone" },
  water: { color: "#8fd3ff", icon: "glass-water" },
  pc: { color: "#7cff9a", icon: "monitor" },
  pi: { color: "#f2b85a", icon: "cpu" },
  door: { color: "#f2b85a", icon: "door-open" },
  window: { color: "#8fd3ff", icon: "app-window" },
  presence: { color: "#c084fc", icon: "radar" },
  battery: { color: "#ff7a7a", icon: "battery-warning" },
  contact: { color: "#38bdf8", icon: "mail" },
  system: { color: "#94a3b8", icon: "info" },
} as const;
export type KindId = keyof typeof KIND_META;
export const KIND_IDS = Object.keys(KIND_META) as KindId[];

const kindSchema = z.object({
  enabled: z.boolean().default(true),
  /** deliver during quiet hours anyway (intercom yes, water no) */
  breakQuiet: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(40).optional(),
});

type KindCfg = z.infer<typeof kindSchema>;
const defaultKinds: Record<KindId, KindCfg> = Object.fromEntries(
  KIND_IDS.map((k) => [k, { enabled: true, breakQuiet: k === "intercom" || k === "door", color: KIND_META[k].color, icon: KIND_META[k].icon }]),
) as Record<KindId, KindCfg>;

/** Partial map in, full map out: unknown kinds dropped, missing ones defaulted. */
const kindsSchema = z.record(z.string(), kindSchema.partial()).default({}).transform((m): Record<KindId, KindCfg> => {
  const out = { ...defaultKinds };
  for (const k of KIND_IDS) if (m[k]) out[k] = { ...defaultKinds[k], ...m[k] };
  return out;
});

export const notifySettingsSchema = z.object({
  version: z.literal(1).default(1),
  kinds: kindsSchema,
  quiet: z.object({ enabled: z.boolean().default(true), from: hhmm.default("23:30"), to: hhmm.default("07:30") }).default({ enabled: true, from: "23:30", to: "07:30" }),
  fcm: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** HA Companion fallback when no paired device acks within 20 s */
  haFallback: z.boolean().default(true),
  /** language for consumers without one of their own (HA Companion fallback) */
  language: z.enum(LOCALES).default("ro"),
  /** water: nudge when below pace by this many ml (0 = off) */
  waterNudgeMl: z.number().int().min(0).max(1000).default(300),
  /** battery: notify below this percent */
  batteryBelow: z.number().int().min(5).max(50).default(20),
});
export type NotifySettings = z.infer<typeof notifySettingsSchema>;

export async function loadNotifySettings(): Promise<NotifySettings> {
  const row = await db.select().from(turzxSettings).where(eq(turzxSettings.id, ROW_ID)).get();
  if (!row) return notifySettingsSchema.parse({});
  const p = notifySettingsSchema.safeParse(JSON.parse(row.json));
  return p.success ? p.data : notifySettingsSchema.parse({});
}

export async function saveNotifySettings(s: unknown): Promise<NotifySettings> {
  const v = notifySettingsSchema.parse(s);
  const json = JSON.stringify(v);
  await db.insert(turzxSettings).values({ id: ROW_ID, json }).onConflictDoUpdate({ target: turzxSettings.id, set: { json, updatedAt: new Date() } });
  return v;
}
