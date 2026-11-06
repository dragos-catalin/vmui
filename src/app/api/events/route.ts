import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { desc, gt } from "drizzle-orm";
import { subscribeEvents, type BusEvent } from "@/lib/event-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 1_000;

/**
 * Server-Sent Events stream for vmui clients. Two sources:
 *
 *   1. Audit-log table: poll every {@link POLL_MS} for rows newer than the
 *      last seen createdAt; emit each one as `event: audit`.
 *   2. In-process event bus: subscribe to the bus singleton and forward
 *      `instance.changed`, `sync.completed`, `snapshot.created` events
 *      with zero polling lag.
 *
 * Frame format follows SSE: `event: <name>\ndata: <json>\n\n`.
 */
export async function GET(req: NextRequest) {
  // The audit log carries pairing codes, intercom events and VM actions: never stream it unauthenticated.
  try {
    await requireRole("viewer");
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const enc = new TextEncoder();
  let cancelled = false;
  let lastSeen = new Date(Date.now() - 60_000);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };
      send("hello", { ts: Date.now() });

      const unsubscribe = subscribeEvents((ev: BusEvent) => {
        send(ev.channel, ev.payload);
      });

      const tick = async () => {
        if (cancelled) return;
        try {
          const rows = await db
            .select()
            .from(auditLog)
            .where(gt(auditLog.createdAt, lastSeen))
            .orderBy(desc(auditLog.createdAt))
            .limit(20);
          if (rows.length > 0) {
            lastSeen = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), lastSeen);
            for (const r of rows.slice().reverse()) send("audit", r);
          }
          // Keep-alive comment so proxies don't drop us.
          if (!cancelled) {
            try {
              controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
            } catch {
              /* closed */
            }
          }
        } catch {
          // Don't break the stream on a transient error.
        }
        if (!cancelled) setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);

      req.signal.addEventListener("abort", () => {
        cancelled = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
