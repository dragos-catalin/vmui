import "server-only";

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { credential } from "@/lib/home/credentials";
import { eq } from "drizzle-orm";
import { z } from "zod";

/**
 * Household-level configuration: everything that used to be a literal for the
 * owner's house (timezone, the owner's phone / person entity, the PC to wake,
 * the hub's public URL). Stored as one JSON row in app_settings so the setup
 * wizard and Settings can edit it; env / credentials.env values seed it, so an
 * existing install keeps working without touching the database.
 */
export const householdSchema = z.object({
  /** IANA zone used for day buckets (water, meals), clocks on screens and i18n. */
  timeZone: z.string().min(1).max(64).default("UTC"),
  /** Language of server-rendered texts that have no viewer: ESP/Turzx screens, HA friendly names, activity feed. */
  locale: z.enum(["en", "ro"]).default("en"),
  /** Owner's HA person entity, e.g. `person.ana` (presence, "away" logic). Empty = none. */
  ownerPerson: z.string().max(120).default(""),
  /** HA companion device slug of the owner's phone, e.g. `pixel_9` (sensors `sensor.<slug>_*`). */
  ownerPhone: z.string().max(120).default(""),
  /** HA notify service for the owner's phone fallback, e.g. `mobile_app_pixel_9`. */
  ownerNotifyService: z.string().max(120).default(""),
  /** Wake-on-LAN target. */
  pcWolMac: z.string().max(32).default(""),
  pcWolIp: z.string().max(64).default(""),
  /** Public base URL of this hub (shown on device screens, QR pairing), no trailing slash. */
  publicUrl: z.string().max(200).default(""),
});
export type Household = z.infer<typeof householdSchema>;

const KEY = "household";

/** Values an existing install already had in env / credentials.env. */
function seed(): Partial<Household> {
  const phoneSvc = credential("PHONE_NOTIFY_SERVICE");
  return {
    timeZone: credential("VATRA_TIMEZONE") ?? process.env.TZ ?? undefined,
    locale: (credential("VATRA_LOCALE") as Household["locale"] | undefined) ?? undefined,
    ownerPerson: credential("VATRA_OWNER_PERSON") ?? undefined,
    ownerPhone: credential("VATRA_OWNER_PHONE") ?? phoneSvc?.replace(/^mobile_app_/, "") ?? undefined,
    ownerNotifyService: phoneSvc ?? undefined,
    pcWolMac: credential("PC_WOL_MAC") ?? undefined,
    pcWolIp: credential("PC_WOL_IP") ?? undefined,
    publicUrl: credential("VATRA_PUBLIC_URL")?.replace(/\/$/, "") ?? undefined,
  };
}

const strip = (o: Partial<Household>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

let cache: { at: number; value: Household } | null = null;

/** Only what someone explicitly set in the UI; defaults and the env seed are never written back. */
function storedOverrides(): Partial<Household> {
  let stored: unknown = {};
  try {
    const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
    if (row) stored = JSON.parse(row.value);
  } catch {
    stored = {};
  }
  // NOT householdSchema.partial(): in zod 4 an optional(default(x)) still yields x for a
  // missing key, so every default would masquerade as an explicit override.
  if (typeof stored !== "object" || stored === null) return {};
  const keys = Object.keys(householdSchema.shape) as (keyof Household)[];
  return Object.fromEntries(keys.flatMap((k) => (typeof (stored as Record<string, unknown>)[k] === "string" ? [[k, (stored as Record<string, string>)[k]]] : []))) as Partial<Household>;
}

/** Synchronous (better-sqlite3), cached 5 s: safe to call from hot paths and sync helpers. */
export function household(): Household {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const parsed = householdSchema.safeParse({ ...strip(seed()), ...storedOverrides() });
  const value = parsed.success ? parsed.data : householdSchema.parse(strip(seed()));
  cache = { at: Date.now(), value };
  return value;
}

export function saveHousehold(patch: Partial<Household>): Household {
  const overrides = { ...storedOverrides(), ...patch };
  householdSchema.parse({ ...strip(seed()), ...overrides });
  const value = JSON.stringify(overrides);
  db.insert(settings).values({ key: KEY, value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } }).run();
  cache = null;
  return household();
}

/** `sensor.<ownerPhone>_<suffix>` or null when no phone is configured. */
export function ownerPhoneSensor(suffix: string): string | null {
  const p = household().ownerPhone;
  return p ? `sensor.${p}_${suffix}` : null;
}

export const householdTimeZone = (): string => household().timeZone;
