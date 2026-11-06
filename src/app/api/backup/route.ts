import { apiError, apiForbidden } from "@/lib/api-error";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { canManageHome, currentHomeActor } from "@/lib/home/access";
import { BackupError, createHubBackup, MIN_PASSPHRASE } from "@/lib/hub-backup";
import { rateLimit } from "@/lib/rate-limit";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/backup  { passphrase }  (owner session) -> the encrypted whole-hub backup file (P5-06)
const body = z.object({ passphrase: z.string().min(MIN_PASSPHRASE).max(512) });

export async function POST(req: NextRequest) {
  const actor = await currentHomeActor();
  if (!actor) return apiError(req, "unauthorized", 401);
  if (!canManageHome(actor)) return apiForbidden(req);
  if (!rateLimit(`backup:${actor.userId}`, 6, 600).ok) return apiError(req, "rate_limited", 429);
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return apiError(req, "backup_weak_passphrase", 400);
  try {
    const { file, info } = await createHubBackup(p.data.passphrase);
    await db.insert(auditLog).values({ action: "backup.create", target: actor.userId, status: "ok", message: `${info.dbBytes} bytes db` });
    const name = `vatra-${info.host}-${info.createdAt.slice(0, 10)}.vatrabk`;
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof BackupError && e.code === "weak") return apiError(req, "backup_weak_passphrase", 400);
    throw e;
  }
}
