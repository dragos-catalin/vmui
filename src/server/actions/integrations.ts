"use server";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { HomeAccessError, requireOwner } from "@/lib/home/access";
import { credential } from "@/lib/home/credentials";
import { saveHousehold, householdSchema, type Household } from "@/lib/household";
import { INTEGRATION_KEYS, integrationsView, writeIntegrations, type IntegrationKey } from "@/lib/integrations";
import { masterKeyFromEnv } from "@/lib/env";
import { rotateMasterKey } from "@/lib/rekey";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Result<T = undefined> = ({ ok: true } & (T extends undefined ? object : { data: T })) | { ok: false; error: string };

const patchSchema = z.partialRecord(z.enum(INTEGRATION_KEYS), z.string().max(8000));

export type IntegrationsView = ReturnType<typeof integrationsView>;

/** New master key + every stored secret re-encrypted in one transaction. Not available
 *  when the key is pinned by VMUI_MASTER_KEY (the env owner rotates it there). */
export async function rotateMasterKeyAction(): Promise<Result<{ rows: number }>> {
  try {
    await requireOwner();
    if (masterKeyFromEnv()) return { ok: false, error: "key_pinned" };
    const r = rotateMasterKey();
    await db.insert(auditLog).values({ accountId: "home", action: "security.master_key.rotate", target: "vatra-master.key", status: "ok", message: `${r.rows} rows re-encrypted` });
    return { ok: true, data: { rows: r.rows } };
  } catch (e) {
    await db.insert(auditLog).values({ accountId: "home", action: "security.master_key.rotate", target: "vatra-master.key", status: "error", message: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : "rotate_failed" };
  }
}

export async function getIntegrationsAction(): Promise<Result<IntegrationsView>> {
  try {
    await requireOwner();
    return { ok: true, data: integrationsView((k) => credential(k)) };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : String(e) };
  }
}

/** Save integration values; for secrets an empty field means "keep", "-" means "clear". */
export async function saveIntegrationsAction(input: Partial<Record<IntegrationKey, string>>): Promise<Result> {
  const p = patchSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid" };
  try {
    await requireOwner();
    const patch: Partial<Record<IntegrationKey, string>> = {};
    for (const [k, v] of Object.entries(p.data) as Array<[IntegrationKey, string]>) {
      if (v === "") continue; // untouched field
      patch[k] = v === "-" ? "" : v.trim();
    }
    if (patch.HA_URL && !/^https?:\/\/[^\s]+$/.test(patch.HA_URL)) return { ok: false, error: "ha_url_invalid" };
    writeIntegrations(patch);
    await db.insert(auditLog).values({ accountId: "home", action: "integrations.save", target: Object.keys(patch).join(","), status: "ok", message: "" });
    revalidatePath("/home");
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : e instanceof Error ? e.message : String(e) };
  }
}

/** Probe HA with the stored (or just-typed) URL + token without saving. */
export async function testHomeAssistantAction(input: { url?: string; token?: string }): Promise<Result<{ version: string; locationName: string }>> {
  try {
    await requireOwner();
    const url = (input.url || credential("HA_URL") || "").replace(/\/$/, "");
    const token = input.token || credential("HA_TOKEN") || "";
    if (!url || !token) return { ok: false, error: "ha_missing" };
    const r = await fetch(`${url}/api/config`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (r.status === 401) return { ok: false, error: "ha_token_rejected" };
    if (!r.ok) return { ok: false, error: `ha_http_${r.status}` };
    const j = (await r.json()) as { version?: string; location_name?: string };
    return { ok: true, data: { version: j.version ?? "?", locationName: j.location_name ?? "" } };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : "ha_unreachable" };
  }
}

export async function saveHouseholdAction(input: Partial<Household>): Promise<Result> {
  const p = householdSchema.partial().safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid" };
  try {
    await requireOwner();
    // only keys the caller actually sent (partial() would add defaults: see household.ts)
    const sent = Object.fromEntries(Object.keys(input).map((k) => [k, (p.data as Record<string, unknown>)[k]])) as Partial<Household>;
    if (sent.timeZone) {
      try { new Intl.DateTimeFormat("en", { timeZone: sent.timeZone }); } catch { return { ok: false, error: "timezone_invalid" }; }
    }
    saveHousehold(sent);
    await db.insert(auditLog).values({ accountId: "home", action: "household.save", target: Object.keys(sent).join(","), status: "ok", message: "" });
    revalidatePath("/home");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : e instanceof Error ? e.message : String(e) };
  }
}
