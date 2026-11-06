import "server-only";

import { decryptJSON, encryptJSON } from "@/lib/crypto";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { registerCredentialStore } from "@/lib/home/credentials";
import { eq } from "drizzle-orm";

/**
 * Integration secrets edited in the UI (setup wizard, Settings → Integrations),
 * stored AES-256-GCM encrypted in app_settings under one key. `credential()` reads
 * env first, then this store, then the legacy `.private/credentials.env`, so an
 * existing install keeps working and a fresh one never needs a file.
 *
 * Only keys in INTEGRATION_KEYS can be written from the UI.
 */
export const INTEGRATION_KEYS = [
  "HA_URL",
  "HA_TOKEN",
  "HA_PUBLIC_DOMAIN",
  "PHONE_NOTIFY_SERVICE",
  "PC_WOL_MAC",
  "PC_WOL_IP",
  "CODAI_API_KEY",
  "FCM_SERVICE_ACCOUNT",
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
/** Values never echoed back to a client (the UI only learns whether they are set). */
export const SECRET_KEYS = new Set<IntegrationKey>(["HA_TOKEN", "CODAI_API_KEY", "FCM_SERVICE_ACCOUNT"]);

const KEY = "integrations.enc";
let cache: { at: number; values: Partial<Record<IntegrationKey, string>> } | null = null;

export function readIntegrations(): Partial<Record<IntegrationKey, string>> {
  if (cache && Date.now() - cache.at < 5_000) return cache.values;
  let values: Partial<Record<IntegrationKey, string>> = {};
  try {
    const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
    if (row) values = decryptJSON<Partial<Record<IntegrationKey, string>>>(row.value);
  } catch {
    // undecryptable (master key changed) or no table yet: behave as empty, never crash credential()
    values = {};
  }
  cache = { at: Date.now(), values };
  return values;
}

/** Merge a patch; an empty string deletes the key. */
export function writeIntegrations(patch: Partial<Record<IntegrationKey, string>>): void {
  const next: Partial<Record<IntegrationKey, string>> = { ...readIntegrations() };
  for (const [k, v] of Object.entries(patch) as Array<[IntegrationKey, string]>) {
    if (!INTEGRATION_KEYS.includes(k)) continue;
    if (v === "") delete next[k];
    else next[k] = v;
  }
  const value = encryptJSON(next);
  db.insert(settings).values({ key: KEY, value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } }).run();
  cache = null;
}

/** For the settings UI: plain values for non-secrets, a boolean for secrets. */
export function integrationsView(resolve: (k: IntegrationKey) => string | undefined): Record<IntegrationKey, { set: boolean; value: string | null }> {
  return Object.fromEntries(
    INTEGRATION_KEYS.map((k) => {
      const v = resolve(k);
      return [k, { set: !!v, value: SECRET_KEYS.has(k) ? null : (v ?? null) }];
    }),
  ) as Record<IntegrationKey, { set: boolean; value: string | null }>;
}

registerCredentialStore((key) => ((INTEGRATION_KEYS as readonly string[]).includes(key) ? readIntegrations()[key as IntegrationKey] : undefined));
