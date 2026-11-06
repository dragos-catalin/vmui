import { ack, dismiss, getCard, listCards, localizeCard, localizeCards, markRead, notify, notifyInputSchema, visibleToRole } from "@/lib/notify";
import { notifyActor } from "@/lib/notify/auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** GET ?all=1 → history incl. dismissed. */
export async function GET(req: NextRequest) {
  const who = await notifyActor(req);
  if (!who) return apiForbidden(req);
  const all = req.nextUrl.searchParams.get("all") === "1";
  const visible = (await listCards({ includeDismissed: all, limit: all ? 200 : 100 })).filter((c) => visibleToRole(c.kind, who.role));
  const cards = await localizeCards(visible, who.locale);
  return NextResponse.json({ cards, now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), ids: z.array(z.string()).max(200) }),
  z.object({ op: z.literal("dismiss"), id: z.string() }),
  z.object({ op: z.literal("dismissAll") }),
  /** a device saw the card (cancels the HA Companion fallback) */
  z.object({ op: z.literal("ack"), ids: z.array(z.string()).max(50) }),
  /** sources without their own module (scripts, HA rest_command) may post a card with the shared token */
  z.object({ op: z.literal("create"), card: notifyInputSchema }),
]);

export async function POST(req: NextRequest) {
  const who = await notifyActor(req);
  if (!who) return apiForbidden(req);
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  switch (p.data.op) {
    case "read":
      await markRead(p.data.ids);
      return NextResponse.json({ ok: true });
    case "dismiss": {
      const target = await getCard(p.data.id);
      if (target && !visibleToRole(target.kind, who.role)) return apiForbidden(req);
      const c = await dismiss(p.data.id, who.by, "dismiss");
      return NextResponse.json({ ok: true, card: c ? await localizeCard(c, who.locale) : null });
    }
    case "dismissAll": {
      for (const c of await listCards()) if (!c.sticky && visibleToRole(c.kind, who.role)) await dismiss(c.id, who.by, "dismiss");
      return NextResponse.json({ ok: true });
    }
    case "ack":
      for (const id of p.data.ids) await ack(id, who.deviceId ?? who.by);
      return NextResponse.json({ ok: true });
    case "create": {
      if (who.deviceId === null) return apiForbidden(req);
      const card = await notify(p.data.card);
      return NextResponse.json({ ok: true, card: card ? await localizeCard(card, who.locale) : null });
    }
  }
}
