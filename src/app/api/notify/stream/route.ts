import { listCards, localizeCard, localizeCards, onNotify, visibleToRole } from "@/lib/notify";
import { notifyActor } from "@/lib/notify/auth";
import "server-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SSE: `snapshot` with open cards on connect, then `upsert` / `dismiss` per card. */
export async function GET(req: Request) {
  const who = await notifyActor(req);
  if (!who) return new Response("forbidden", { status: 403 });
  const enc = new TextEncoder();
  let off: (() => void) | null = null;
  let ping: NodeJS.Timeout | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      const mine = (await listCards()).filter((c) => visibleToRole(c.kind, who.role));
      send("snapshot", { cards: await localizeCards(mine, who.locale), now: Date.now() });
      off = onNotify((ev) => {
        if (!visibleToRole(ev.card.kind, who.role)) return;
        void localizeCard(ev.card, who.locale).then((c) => send(ev.type, c));
      });
      ping = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 25_000);
      req.signal.addEventListener("abort", () => { off?.(); if (ping) clearInterval(ping); try { controller.close(); } catch { /* already */ } }, { once: true });
    },
    cancel() {
      off?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
