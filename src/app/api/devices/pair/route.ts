import { localeFromAcceptLanguage } from "@/i18n/config";
import { verifyUserPassword } from "@/lib/auth";
import { approveByLogin, pairingStatus, redeemPairingInvite, requestPairing } from "@/lib/devices/pairing";
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-error";
import { pairBody } from "@/lib/devices/pair-body";

export const dynamic = "force-dynamic";

// Unauthenticated by design: this is how a new phone introduces itself.
// Rate-limited per IP; the only thing an attacker gains is a pending row that
// nobody approves and that expires in 10 minutes.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}
const ipOf = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;
// the phone's UI language, so its notifications render in it (lib/notify/i18n.ts)
const langOf = (req: NextRequest) => localeFromAcceptLanguage(req.headers.get("accept-language"));

/** POST: start a pairing request, or sign in with the vmui account for instant approval. */
export async function POST(req: NextRequest) {
  const ip = ipOf(req);
  if (limited(ip ?? "?")) return apiError(req, "rate_limited", 429);
  const p = pairBody.safeParse(await req.json().catch(() => null));
  if (!p.success) return apiError(req, "invalid_request", 400);
  if ("invite" in p.data) {
    const t = await redeemPairingInvite(p.data.invite, p.data.name, p.data.platform, ip, langOf(req));
    if (!t) return apiError(req, "invite_invalid", 401);
    return NextResponse.json({ id: t.id, token: t.token, status: "approved" });
  }
  if ("email" in p.data) {
    const r = await verifyUserPassword(p.data.email, p.data.password);
    if (!r.ok) return apiError(req, "bad_credentials", 401);
    const t = await approveByLogin(p.data.name, p.data.platform, ip, r.user.email, langOf(req), r.user.id);
    return NextResponse.json({ id: t.id, token: t.token, status: "approved" });
  }
  const t = await requestPairing(p.data.name, p.data.platform, ip, langOf(req));
  return NextResponse.json({ id: t.id, token: t.token, code: t.code, status: "pending" });
}

/** GET ?id=: poll until approved/rejected. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{16}$/.test(id)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const s = await pairingStatus(id);
  if (!s) return NextResponse.json({ status: "rejected" });
  return NextResponse.json(s, { headers: { "Cache-Control": "no-store" } });
}
