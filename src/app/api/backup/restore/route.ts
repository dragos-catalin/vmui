import { apiError, apiForbidden } from "@/lib/api-error";
import { userCount } from "@/lib/auth";
import { canManageHome, currentHomeActor } from "@/lib/home/access";
import { BackupError, MAX_BACKUP_BYTES, stageHubRestore } from "@/lib/hub-backup";
import { rateLimit } from "@/lib/rate-limit";
import { burnSetupCode, checkSetupCode } from "@/lib/setup-code";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/backup/restore  multipart { file, passphrase, setupCode? }   (P5-06)
// Claimed hub: the owner's session. Unclaimed hub (a fresh replacement): the setup code proves
// physical access, exactly like claiming it. The verified database is staged and swapped in at
// the next boot; the process exits so systemd / Docker restarts it.
const ERRORS = {
  format: "backup_format",
  version: "backup_format",
  passphrase: "backup_passphrase",
  database: "backup_format",
  weak: "backup_passphrase",
} as const;

const ipOf = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";

export async function POST(req: NextRequest) {
  if (!rateLimit(`restore:${ipOf(req)}`, 8, 600).ok) return apiError(req, "rate_limited", 429);
  const claimed = (await userCount()) > 0;
  const form = await req.formData().catch(() => null);
  if (!form) return apiError(req, "invalid_request", 400);
  let actor = "setup-code";
  if (claimed) {
    const a = await currentHomeActor();
    if (!a) return apiError(req, "unauthorized", 401);
    if (!canManageHome(a)) return apiForbidden(req);
    actor = a.userId;
  } else {
    const check = checkSetupCode(String(form.get("setupCode") ?? ""));
    if (check === "locked") return apiError(req, "rate_limited", 429);
    if (check !== "ok") return apiError(req, "setup_code_wrong", 403);
  }
  const file = form.get("file");
  const passphrase = String(form.get("passphrase") ?? "");
  if (!(file instanceof Blob) || file.size === 0 || file.size > MAX_BACKUP_BYTES || !passphrase) return apiError(req, "invalid_request", 400);
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const info = stageHubRestore(buf, passphrase, actor);
    if (!claimed) burnSetupCode();
    // let the response flush, then exit: the supervisor (systemd Restart=always / compose
    // restart: unless-stopped) starts us again and instrumentation swaps the staged files in
    setTimeout(() => process.exit(0), 750).unref();
    return NextResponse.json({ ok: true, restarting: true, info }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof BackupError) return apiError(req, ERRORS[e.code], 400);
    throw e;
  }
}
