import { apiError } from "@/lib/api-error";
import { createPairingInvite } from "@/lib/devices/pairing";
import { homeActorFromRequest } from "@/lib/home/access";
import { household } from "@/lib/household";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/devices/pair/invite — a signed-in member (browser session or a paired device)
// asks for a one-time QR to add another device of theirs. The new device redeems it at
// POST /api/devices/pair {invite} and acts as this member (family rooms apply).
export async function POST(req: NextRequest) {
  const actor = await homeActorFromRequest(req);
  if (!actor) return apiError(req, "unauthorized", 401);
  const { code, expiresAt } = createPairingInvite(actor.userId, actor.email || actor.displayName || actor.userId);
  // the address the app should use: the public URL when configured, else the one the browser used
  const hub = household().publicUrl || new URL(req.url).origin;
  const link = `vatra://pair?h=${encodeURIComponent(hub)}&c=${encodeURIComponent(code)}`;
  return NextResponse.json({ link, code, hub, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
