import "server-only";

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

/** Bump when the disclosure text changes in substance (what is sent, to whom): everyone is asked again. */
export const AI_CONSENT_VERSION = 1;

const recordSchema = z.object({ granted: z.boolean(), version: z.number().int(), at: z.number() });
export type AiConsent = z.infer<typeof recordSchema>;

/** One app_settings row per user. `solo` = auth disabled (dev only, VMUI_SOLO_MODE). */
export const aiConsentKey = (userId: string | null | undefined) => `ai_consent:${userId || "solo"}`;

export async function getAiConsent(userId: string | null | undefined): Promise<AiConsent | null> {
  const row = await db.select().from(settings).where(eq(settings.key, aiConsentKey(userId))).get();
  if (!row) return null;
  try {
    const p = recordSchema.safeParse(JSON.parse(row.value));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Granted for the current disclosure version. Anything else (missing, revoked, older version) = no. */
export async function hasAiConsent(userId: string | null | undefined): Promise<boolean> {
  const c = await getAiConsent(userId);
  return !!c && c.granted && c.version === AI_CONSENT_VERSION;
}

export async function setAiConsent(userId: string | null | undefined, granted: boolean): Promise<AiConsent> {
  const value: AiConsent = { granted, version: AI_CONSENT_VERSION, at: Date.now() };
  const key = aiConsentKey(userId);
  await db
    .insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: new Date() } });
  return value;
}

export async function deleteAiConsent(userId: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, aiConsentKey(userId)));
}
