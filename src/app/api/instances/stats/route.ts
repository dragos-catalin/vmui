import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { instances } from "@/lib/db/schema";
import type { InstanceStatsSample } from "@/lib/providers/types";
import { getInstanceStatsAction } from "@/server/actions/local-kvm";
import { inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 24;
const TTL_MS = 2_000;

type Entry = { at: number; pending: Promise<InstanceStatsSample | null> };

declare global {
  // eslint-disable-next-line no-var
  var __vmuiFleetStatsCache__: Map<string, Entry> | undefined;
}

function cache(): Map<string, Entry> {
  globalThis.__vmuiFleetStatsCache__ ??= new Map();
  return globalThis.__vmuiFleetStatsCache__;
}

/** Same source as /api/instances/{id}/stats/stream, deduped across tabs and
 *  cards for TTL_MS so N viewers cost one sample per instance. */
function sample(id: string, accountId: string, providerInstanceId: string): Promise<InstanceStatsSample | null> {
  const c = cache();
  const hit = c.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pending;
  const pending = getInstanceStatsAction(accountId, providerInstanceId)
    .then((r) => (r.ok ? r.sample : null))
    .catch(() => null);
  c.set(id, { at: Date.now(), pending });
  return pending;
}

/**
 * One poll for every visible running card:
 *   GET /api/instances/stats?ids=a,b,c  ->  { samples: { [id]: InstanceStatsSample | null } }
 */
export async function GET(req: NextRequest) {
  try {
    await requireRole("viewer");
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ samples: {} });

  const rows = await db
    .select({ id: instances.id, accountId: instances.accountId, providerInstanceId: instances.providerInstanceId })
    .from(instances)
    .where(inArray(instances.id, ids));

  const entries = await Promise.all(rows.map(async (r) => [r.id, await sample(r.id, r.accountId, r.providerInstanceId)] as const));
  return NextResponse.json(
    { samples: Object.fromEntries(entries) },
    { headers: { "cache-control": "no-store" } },
  );
}
