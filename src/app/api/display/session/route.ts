import { apiForbidden } from "@/lib/api-error";
import { KIOSK_COOKIE, mintKioskCode, redeemKioskCode } from "@/lib/display/kiosk-session";
import { espAuthorized, requestCredential } from "@/lib/esp/auth";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/display/session          (Authorization: Bearer <nestHub token>) -> { code, url }
//   hub-cast asks for a one-time code right before it casts.
// GET  /api/display/session?code=…   the Nest Hub follows it: sets the httpOnly kiosk cookie
//   (valid on kiosk paths only, lib/esp/auth.ts) and redirects to /display. The URL the Hub
//   loads never holds a token, and the code dies on first use or after 5 minutes.
export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const code = mintKioskCode(requestCredential(req));
  return NextResponse.json({ code, url: `/api/display/session?code=${code}` }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const credential = code ? redeemKioskCode(code) : null;
  if (!credential) return apiForbidden(req);
  const keep = new URLSearchParams(req.nextUrl.searchParams);
  keep.delete("code");
  const res = NextResponse.redirect(new URL(`/display${keep.size ? `?${keep}` : ""}`, req.url), 303);
  // the Hub is on the LAN over plain http: Secure would drop the cookie there
  res.cookies.set(KIOSK_COOKIE, credential, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 400 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
