import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, webhooks, type WebhookRow } from "@/lib/db/schema";
import { subscribeEvents, type BusEvent } from "@/lib/event-bus";

interface DispatcherState {
  started: boolean;
  unsubscribe: (() => void) | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __vmuiWebhookDispatcher__: DispatcherState | undefined;
}

function state(): DispatcherState {
  if (!globalThis.__vmuiWebhookDispatcher__) {
    globalThis.__vmuiWebhookDispatcher__ = { started: false, unsubscribe: null };
  }
  return globalThis.__vmuiWebhookDispatcher__;
}

function parseChannels(json: string): string[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) return arr as string[];
  } catch {
    // ignore
  }
  return [];
}

function summarize(e: BusEvent): string {
  switch (e.channel) {
    case "instance.changed":
      return `Instance ${e.payload.providerInstanceId} → ${e.payload.state}${e.payload.prev ? ` (was ${e.payload.prev})` : ""}`;
    case "sync.completed":
      return `Sync ${e.payload.accountId}/${e.payload.region}: ${e.payload.count} instance(s) in ${e.payload.durationMs}ms`;
    case "snapshot.created":
      return `Snapshot ${e.payload.snapshotId} created for ${e.payload.providerInstanceId}`;
    case "notification.created":
      return `[${e.payload.severity}] ${e.payload.title}`;
    case "alert.fired":
      return `[${e.payload.severity}] ${e.payload.ruleName}: ${e.payload.message}`;
  }
}

function bodyFor(hook: WebhookRow, e: BusEvent): unknown {
  const text = summarize(e);
  if (hook.kind === "slack") {
    return { text: `*vmui* · ${text}` };
  }
  if (hook.kind === "discord") {
    return { content: `**vmui** · ${text}` };
  }
  if (hook.kind === "teams") {
    // Microsoft Teams Incoming Webhook (legacy MessageCard format)
    return {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor: "0078D4",
      summary: "Vatra event",
      title: "Vatra",
      text,
    };
  }
  return { source: "vmui", channel: e.channel, payload: e.payload, summary: text };
}

export async function deliver(hook: WebhookRow, e: BusEvent): Promise<void> {
  const body = bodyFor(hook, e);
  let status = "unknown";
  let ok = false;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    status = `${res.status}`;
    ok = res.ok;
  } catch (err) {
    status = err instanceof Error ? err.message.slice(0, 120) : "fetch failed";
  }
  await db.insert(auditLog).values({
    action: "webhook.delivery",
    target: hook.id,
    status: ok ? "ok" : "error",
    message: `${hook.name} · ${e.channel} · ${status}`,
  });
  await db
    .update(webhooks)
    .set({ lastFiredAt: new Date(), lastStatus: status })
    .where(eq(webhooks.id, hook.id));
}

/** Idempotent. Safe to call from layout, route handlers, or scheduler. */
export function startWebhookDispatcher(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  s.unsubscribe = subscribeEvents(async (e) => {
    try {
      const hooks = await db.select().from(webhooks).where(eq(webhooks.enabled, 1));
      for (const h of hooks) {
        const channels = parseChannels(h.channels);
        if (!channels.includes(e.channel)) continue;
        if (h.cooldownSec && h.lastFiredAt) {
          const elapsed = (Date.now() - h.lastFiredAt.getTime()) / 1000;
          if (elapsed < h.cooldownSec) continue;
        }
        // Fire-and-forget; deliver() handles its own errors.
        void deliver(h, e);
      }
    } catch {
      // dispatcher must never throw
    }
  });
}
