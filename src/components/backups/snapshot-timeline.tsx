"use client";

import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, EmptyState } from "@/components/ui";
import type { SnapshotEvent } from "@/server/queries/snapshots";
import { HardDrive } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { formatBytes } from "./bytes";

/** Provider hues live in the theme so light/dark flip together; unknown providers fall back to primary. */
const PROVIDER_VAR: Record<string, string> = {
  aws: "var(--color-warning)",
  azure: "var(--color-info)",
  gcp: "var(--color-success)",
  digitalocean: "var(--color-info)",
  hetzner: "var(--color-danger)",
  scaleway: "var(--color-accent)",
  "local-kvm": "var(--color-fg-muted)",
};

export function SnapshotTimeline({ events }: { events: SnapshotEvent[] }) {
  const t = useTranslations("ops.backups.timeline");
  const format = useFormatter();
  const grouped = useMemo(() => {
    const map = new Map<string, SnapshotEvent[]>();
    for (const e of events) {
      const d = new Date(e.capturedAt);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const arr = map.get(k);
      if (arr) arr.push(e);
      else map.set(k, [e]);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [events]);

  if (events.length === 0) {
    return <EmptyState compact icon={<HardDrive />} title={t("empty")} description={t("emptyHint")} />;
  }

  let index = 0;
  return (
    <div className="relative pl-6">
      <div className="absolute bottom-0 left-2 top-0 w-px bg-border" aria-hidden />
      <div className="space-y-6">
        {grouped.map(([dayKey, items]) => {
          const first = items[0];
          return (
            <div key={dayKey}>
              <div className="relative mb-2 flex items-center gap-3">
                <div className="absolute -left-[18px] size-2.5 rounded-full bg-primary ring-4 ring-surface" aria-hidden />
                <h3 className="text-sm font-semibold">
                  {first ? format.dateTime(new Date(first.capturedAt), { weekday: "short", year: "numeric", month: "short", day: "numeric" }) : dayKey}
                </h3>
                <span className="text-[11px] text-fg-muted">{t("count", { count: items.length })}</span>
              </div>
              <div className="space-y-2">
                {items.map((e) => {
                  const i = index++;
                  const hue = PROVIDER_VAR[e.provider] ?? "var(--color-primary)";
                  return (
                    <m.div
                      key={e.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                      className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-xs"
                    >
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ background: `color-mix(in oklch, ${hue} 22%, transparent)`, color: hue }}
                      >
                        {e.provider}
                      </span>
                      <HardDrive className="size-3.5 text-fg-muted" aria-hidden />
                      <div className="min-w-0 flex-1 truncate font-medium">{e.name ?? e.externalId}</div>
                      <span className="text-fg-muted">{e.region}</span>
                      <span className="tabular-nums text-fg-muted">{formatBytes(e.sizeBytes)}</span>
                      {e.status && <Badge variant="muted">{e.status}</Badge>}
                      <RelativeTime date={e.capturedAt} className="text-fg-muted" />
                    </m.div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
