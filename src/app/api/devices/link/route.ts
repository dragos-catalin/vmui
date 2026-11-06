import { apiError, apiForbidden } from "@/lib/api-error";
import { mintLinkCode } from "@/lib/display/kiosk-session";
import { espAuthorized, requestCredential } from "@/lib/esp/auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// POST /api/devices/link   Authorization: Bearer vmd_…   body { path }
// For a client that must hand a URL to something that cannot send headers (the phone's browser
// downloading the APK, the Nest Hub): returns a one-time URL valid 5 minutes for that one path.
// The caller's token must itself be allowed on `path` (appliance scopes apply).
const LINKABLE = ["/display", "/api/desktop/apk"] as const;
const body = z.object({ path: z.enum(LINKABLE) });

export async function POST(req: NextRequest) {
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return apiError(req, "invalid_request", 400);
  const probe = new Request(new URL(p.data.path, req.url), { headers: req.headers });
  const cred = requestCredential(probe);
  // header credentials only: a link code must not mint another one
  if (!cred || new URL(req.url).searchParams.size > 0 || !espAuthorized(probe)) return apiForbidden(req);
  const code = mintLinkCode(cred, p.data.path);
  const url = p.data.path === "/display" ? `/api/display/session?code=${code}` : `${p.data.path}?once=${code}`;
  return NextResponse.json({ ok: true, url }, { headers: { "Cache-Control": "no-store" } });
}
