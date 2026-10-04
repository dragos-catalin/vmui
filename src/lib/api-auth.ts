import "server-only";

import { parseApiKeyScopes, type ApiKeyScopes } from "@/lib/api-key-scopes";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys, type ApiKeyRow } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

export type ApiAuthResult =
  | { ok: true; keyId: string; role: ApiKeyRow["role"]; rateLimitPerMinute: number; scopes: ApiKeyScopes | null }
  | { ok: false; status: 401 | 403 | 429; error: string };

type RateBucket = { count: number; windowStart: number };

const RATE_MAP_KEY = "__vmuiApiRateMap__" as const;
type GlobalWithRate = typeof globalThis & { [RATE_MAP_KEY]?: Map<string, RateBucket> };

function rateMap(): Map<string, RateBucket> {
  const g = globalThis as GlobalWithRate;
  if (!g[RATE_MAP_KEY]) g[RATE_MAP_KEY] = new Map();
  return g[RATE_MAP_KEY]!;
}

function consume(keyId: string, limit: number): boolean {
  const now = Date.now();
  const map = rateMap();
  const bucket = map.get(keyId);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    map.set(keyId, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/**
 * Indexed lookup handle for a token: the first 16 hex chars of its SHA-256. Derivable from
 * any token (old keys too), so a request finds its row without running scrypt against every
 * key; scrypt still verifies the match. 64 bits of a hash of a 256-bit random secret reveal
 * nothing usable. scripts/mint-api-key.mjs computes the same value.
 */
export function apiKeyLookupId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Issue a fresh plaintext key. Returns the key (shown once), the storable hash and its lookup id. */
export async function generateApiKey(): Promise<{ plaintext: string; hash: string; lookupId: string }> {
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const plaintext = `vmui_${random}`;
  const hash = await hashPassword(plaintext);
  return { plaintext, hash, lookupId: apiKeyLookupId(plaintext) };
}

async function findKey(token: string): Promise<ApiKeyRow | null> {
  const lookupId = apiKeyLookupId(token);
  const indexed = await db.select().from(apiKeys).where(and(eq(apiKeys.lookupId, lookupId), isNull(apiKeys.revokedAt)));
  for (const row of indexed) {
    if (await verifyPassword(token, row.hash)) return row;
  }
  // Keys minted before lookup ids existed: scan only those, and backfill the one that matches.
  const legacy = await db.select().from(apiKeys).where(and(isNull(apiKeys.lookupId), isNull(apiKeys.revokedAt)));
  for (const row of legacy) {
    if (await verifyPassword(token, row.hash)) {
      await db.update(apiKeys).set({ lookupId }).where(eq(apiKeys.id, row.id));
      return row;
    }
  }
  return null;
}

export async function validateApiKey(req: Request): Promise<ApiAuthResult> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return { ok: false, status: 401, error: "Missing bearer token" };
  const token = m[1]!.trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const row = await findKey(token);
  if (!row) return { ok: false, status: 401, error: "Invalid token" };
  if (!consume(row.id, row.rateLimitPerMinute)) {
    return { ok: false, status: 429, error: "Rate limit exceeded" };
  }
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return {
    ok: true,
    keyId: row.id,
    role: row.role,
    rateLimitPerMinute: row.rateLimitPerMinute,
    scopes: parseApiKeyScopes(row.scopes),
  };
}

export function requireApiRole(
  result: ApiAuthResult,
  min: "viewer" | "operator",
): ApiAuthResult {
  if (!result.ok) return result;
  if (min === "operator" && result.role !== "operator") {
    return { ok: false, status: 403, error: "Operator role required" };
  }
  return result;
}
