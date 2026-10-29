import { getCurrentUser } from "@/lib/auth";
import { approveDevice, deviceFromRequest, devicesVersion, listDevices, pendingDevices, rejectDevice, renameDevice, revokeDevice } from "@/lib/devices/pairing";
import { espAuthorized } from "@/lib/esp/auth";
import { ownerActor } from "@/lib/home/access";
import { deviceLocale } from "@/lib/notify/i18n";
import { getTranslations } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Who may manage devices: a signed-in vmui user (web /home), an already-
// approved device (the "approve from the phone you already have" path), or
// the desktop app on the PC that holds .private/credentials.env (shared token).
// `userId` is the member a newly approved device gets bound to: the approver
// themselves, or the member the approving device already acts as.
type Actor = { by: string; userId: string | null };
async function actor(req: NextRequest): Promise<Actor | null> {
  const u = await getCurrentUser().catch(() => null);
  if (u) return { by: u.email, userId: u.id };
  const d = await deviceFromRequest(req);
  if (d) return { by: `device:${d.name}`, userId: d.userId };
  // shared token has no identity; the device stays unbound until rebound in the family card
  return espAuthorized(req) ? { by: "desktop:shared-token", userId: null } : null;
}

/** GET: everything + pending (with codes) for banners. `?since=N` long-polls up to 25 s for a change. */
export async function GET(req: NextRequest) {
  if (!(await actor(req))) return new NextResponse("forbidden", { status: 403 });
  const since = Number(req.nextUrl.searchParams.get("since") ?? NaN);
  if (Number.isFinite(since)) {
    const until = Date.now() + 25_000;
    while (devicesVersion() === since && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  }
  const [devices, pending] = await Promise.all([listDevices(), pendingDevices()]);
  return NextResponse.json({ devices, pending, version: devicesVersion() }, { headers: { "Cache-Control": "no-store" } });
}

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("approve"), id: z.string().length(16), code: z.string().length(4) }),
  z.object({ op: z.literal("reject"), id: z.string().length(16) }),
  z.object({ op: z.literal("revoke"), id: z.string().length(16) }),
  z.object({ op: z.literal("rename"), id: z.string().length(16), name: z.string().min(1).max(64) }),
]);

export async function POST(req: NextRequest) {
  const who = await actor(req);
  if (!who) return new NextResponse("forbidden", { status: 403 });
  const by = who.by;
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  switch (p.data.op) {
    case "approve": {
      // The shared token is the owner's PC: a Vitals app approved from it acts as the owner (bindingFor).
      const owner = who.userId ? null : await ownerActor();
      const r = await approveDevice(p.data.id, p.data.code, by, who.userId, owner && owner.userId !== "solo" ? owner.userId : null);
      if (r.ok) return NextResponse.json(r);
      // the client shows `error` verbatim, so render it in the caller's language here
      const t = await getTranslations({ locale: deviceLocale(req.headers.get("accept-language")), namespace: "notify.errors.pairing" });
      return NextResponse.json({ ok: false, error: t(r.error) }, { status: 400 });
    }
    case "reject":
      await rejectDevice(p.data.id, by);
      return NextResponse.json({ ok: true });
    case "revoke":
      await revokeDevice(p.data.id, by);
      return NextResponse.json({ ok: true });
    case "rename":
      await renameDevice(p.data.id, p.data.name);
      return NextResponse.json({ ok: true });
  }
}
