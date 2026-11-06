import "server-only";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { cloudAccounts, schedules } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BridgeGlobal { __vmuiSshBridge?: unknown }

export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try { await db.run(sql`SELECT 1`); checks.db = { ok: true }; }
  catch (e) { checks.db = { ok: false, detail: String(e) }; }

  checks.masterKey = { ok: Boolean(env.VMUI_MASTER_KEY) };

  try {
    const accs = await db.select({ id: cloudAccounts.id, p: cloudAccounts.provider }).from(cloudAccounts);
    const byProvider: Record<string, number> = {};
    for (const a of accs) byProvider[a.p] = (byProvider[a.p] ?? 0) + 1;
    checks.providers = { ok: true, detail: `${accs.length} account(s): ${JSON.stringify(byProvider)}` };
  } catch (e) { checks.providers = { ok: false, detail: String(e) }; }

  try {
    const tasks = await db.select().from(schedules);
    const enabled = tasks.filter((t) => t.enabled).length;
    checks.scheduler = { ok: true, detail: `${enabled}/${tasks.length} enabled` };
  } catch (e) { checks.scheduler = { ok: false, detail: String(e) }; }

  const g = globalThis as unknown as BridgeGlobal;
  const present = Boolean(g.__vmuiSshBridge);
  checks.sshBridge = { ok: true, detail: present ? "singleton present" : "not initialized (lazy)" };

  const ok = Object.values(checks).every((c) => c.ok);
  return new Response(
    JSON.stringify({
      ok,
      checks,
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      version: process.env.VATRA_VERSION ?? "0.0.0",
      latencyMs: Date.now() - started,
      ts: Date.now(),
    }, null, 2),
    { status: ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
