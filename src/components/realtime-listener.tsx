"use client";

import { useEventsBus } from "@/hooks/use-poll";
import { categorizeError } from "@/lib/errors";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

interface AuditEvent {
  id: number;
  accountId: string | null;
  action: string;
  target: string | null;
  status: "ok" | "error";
  message: string | null;
  createdAt: string;
}

interface InstanceChangedPayload {
  accountId: string;
  providerInstanceId: string;
  state: string;
  prev: string | null;
}

interface SyncCompletedPayload {
  accountId: string;
  region: string;
  count: number;
  added?: number;
  removed?: number;
  stateChanged?: number;
}

const QUIET_ACTIONS = new Set(["sync.region"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Surfaces important audit-log rows from the shared /api/events bus as toasts, and pings
 * router.refresh() on low-latency bus events (instance.changed, sync.completed) so server
 * components pick up new data. One EventSource per tab is shared through useEventsBus.
 */
export function RealtimeListener() {
  const router = useRouter();
  const t = useTranslations("misc.realtime");
  const lastRefresh = useRef(0);

  const refresh = (minIntervalMs: number) => {
    const now = Date.now();
    if (now - lastRefresh.current > minIntervalMs) {
      lastRefresh.current = now;
      router.refresh();
    }
  };

  useEventsBus({
    audit: (data) => {
      if (!isObject(data)) return;
      const ev = data as unknown as AuditEvent;
      if (!QUIET_ACTIONS.has(ev.action)) {
        if (ev.status === "error") {
          const cat = categorizeError(ev.message ?? ev.action);
          const description = cat.hint ? `${cat.message}\n${cat.hint}` : cat.message;
          toast.error(`${ev.action}${ev.target ? ` · ${ev.target}` : ""}`, { description });
        } else if (ev.action.startsWith("recipe.") || ev.action.startsWith("sync.")) {
          toast.success(ev.action, { description: ev.target ?? undefined });
        }
      }
      refresh(1500);
    },
    "instance.changed": (data) => {
      if (isObject(data)) {
        const p = data as unknown as InstanceChangedPayload;
        if (p.prev && p.prev !== p.state) {
          toast(t("transition", { id: p.providerInstanceId, prev: p.prev, state: p.state }));
        }
      }
      refresh(500);
    },
    "sync.completed": (data) => {
      if (isObject(data)) {
        const p = data as unknown as SyncCompletedPayload;
        const added = p.added ?? 0;
        const removed = p.removed ?? 0;
        const changed = p.stateChanged ?? 0;
        if (added + removed + changed > 0) {
          const parts: string[] = [];
          if (added) parts.push(`+${added}`);
          if (removed) parts.push(`-${removed}`);
          if (changed) parts.push(t("stateChanges", { count: changed }));
          toast(t("syncTitle", { region: p.region }), { description: parts.join(" / ") });
        }
      }
      refresh(800);
    },
    "snapshot.created": (data) => {
      if (isObject(data) && typeof data.snapshotId === "string") {
        toast.success(t("snapshotCreated"), { description: data.snapshotId });
      }
      refresh(500);
    },
  });

  return null;
}
