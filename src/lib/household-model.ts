import { z } from "zod";

// Client-safe half of lib/household.ts (schema + type). The store lives server-side.
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
