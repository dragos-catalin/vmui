import { homeActorOrOwner } from "@/lib/home/access";
import { localizeCard } from "@/lib/notify";
import { runAction } from "@/lib/notify/actions";
import { notifyActor } from "@/lib/notify/auth";
import { render } from "@/lib/notify/i18n";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const body = z.object({ id: z.string().min(1), action: z.string().min(1).max(40) });

/** A button on a card was tapped (phone, desktop, web). */
export async function POST(req: NextRequest) {
  const who = await notifyActor(req);
  if (!who) return apiForbidden(req);
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  // bound device / session → that member; shared desktop token → the owner (it is their PC);
  // an approved but unbound device gets no household actor and so cannot open the door
  const actor = await homeActorOrOwner(req, who.deviceId === "desktop");
  const r = await runAction(p.data.id, p.data.action, who.by, actor);
  if (!r.ok) return NextResponse.json({ ok: false, error: await render(r.error, who.locale) }, { status: r.error === "forbidden" ? 403 : 400 });
  const out = { ok: true, message: r.message == null ? undefined : await render(r.message, who.locale), card: r.card ? await localizeCard(r.card, who.locale) : r.card };
  return NextResponse.json(out);
}
