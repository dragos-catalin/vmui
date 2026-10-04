"use server";

import { generateApiKey } from "@/lib/api-auth";
import { apiKeyScopesSchema, isUnrestricted, type ApiKeyScopes } from "@/lib/api-key-scopes";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys, auditLog, instances } from "@/lib/db/schema";
import { PC_ACTIONS, TOOL_BY_NAME } from "@/lib/mcp/tools";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import "server-only";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["operator", "viewer"]),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
  scopes: apiKeyScopesSchema.optional(),
});

const dedupe = (xs: string[] | undefined) => (xs ? [...new Set(xs)] : undefined);

/** Drops empty lists, rejects unknown tool/PC/VM ids. Returns null for an unrestricted key. */
async function normalizeScopes(input: ApiKeyScopes | undefined): Promise<{ ok: true; scopes: ApiKeyScopes | null } | { ok: false; error: string }> {
  if (!input) return { ok: true, scopes: null };
  const scopes: ApiKeyScopes = {
    tools: dedupe(input.tools),
    vmIds: dedupe(input.vmIds),
    entities: dedupe(input.entities),
    pcActions: dedupe(input.pcActions),
    scripts: dedupe(input.scripts),
  };
  const unknownTools = scopes.tools?.filter((n) => !TOOL_BY_NAME.has(n)) ?? [];
  if (unknownTools.length) return { ok: false, error: `Unknown tools: ${unknownTools.join(", ")}` };
  const knownPc = new Set<string>(PC_ACTIONS);
  const unknownPc = scopes.pcActions?.filter((a) => !knownPc.has(a)) ?? [];
  if (unknownPc.length) return { ok: false, error: `Unknown PC actions: ${unknownPc.join(", ")}` };
  if (scopes.vmIds?.length) {
    const rows = await db.select({ id: instances.id }).from(instances).where(inArray(instances.id, scopes.vmIds));
    const found = new Set(rows.map((r) => r.id));
    const unknownVms = scopes.vmIds.filter((id) => !found.has(id));
    if (unknownVms.length) return { ok: false, error: `Unknown VMs: ${unknownVms.join(", ")}` };
  }
  return { ok: true, scopes: isUnrestricted(scopes) ? null : scopes };
}

function describeScopes(s: ApiKeyScopes | null): string {
  if (!s) return "unrestricted";
  const parts: string[] = [];
  if (s.tools) parts.push(`${s.tools.length} tools`);
  if (s.vmIds) parts.push(`${s.vmIds.length} vms`);
  if (s.entities) parts.push(`${s.entities.length} entities`);
  if (s.pcActions) parts.push(`${s.pcActions.length} pc actions`);
  if (s.scripts) parts.push(`${s.scripts.length} scripts`);
  return parts.join(", ");
}

export async function createApiKeyAction(
  input: z.infer<typeof createSchema>,
): Promise<{ ok: true; id: string; plaintext: string } | { ok: false; error: string }> {
  try {
    await requireRole("admin");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not authorized" };
  }
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  // Viewer keys never reach /api/mcp, so scopes only make sense on operator keys.
  const normalized = await normalizeScopes(parsed.data.role === "operator" ? parsed.data.scopes : undefined);
  if (!normalized.ok) return normalized;
  const id = nanoid();
  const { plaintext, hash, lookupId } = await generateApiKey();
  await db.insert(apiKeys).values({
    id,
    name: parsed.data.name,
    hash,
    lookupId,
    role: parsed.data.role,
    rateLimitPerMinute: parsed.data.rateLimitPerMinute,
    scopes: normalized.scopes ? JSON.stringify(normalized.scopes) : null,
  });
  await db.insert(auditLog).values({
    action: "api-key.create",
    target: id,
    status: "ok",
    message: `${parsed.data.name} role=${parsed.data.role} scopes=${describeScopes(normalized.scopes)}`,
  });
  revalidatePath("/settings/api-keys");
  return { ok: true, id, plaintext };
}

export async function revokeApiKeyAction(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireRole("admin");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not authorized" };
  }
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
  await db.insert(auditLog).values({
    action: "api-key.revoke",
    target: id,
    status: "ok",
  });
  revalidatePath("/settings/api-keys");
  return { ok: true };
}
