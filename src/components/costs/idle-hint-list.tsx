"use client";

import { ProviderTile } from "@/components/cloud/provider-tile";
import { Badge } from "@/components/ui";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";

export interface IdleHint {
  instanceId: string;
  providerInstanceId: string;
  name: string;
  averageCpuPct: number;
}

const MAX_ANIMATED = 12;

export function IdleHintList({ hints }: { hints: IdleHint[] }) {
  const t = useTranslations("cloud.costs.idle");
  return (
    <ul className="grid gap-2">
      {hints.map((h, i) => (
        <m.li
          key={h.instanceId}
          initial={i < MAX_ANIMATED ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: Math.min(i, MAX_ANIMATED) * 0.03 }}
        >
          <Link
            href={`/instances/${encodeURIComponent(h.instanceId)}`}
            className="surface card-hover flex min-h-14 items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ProviderTile provider="aws" size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{h.name}</span>
              <span className="block truncate font-mono text-xs text-muted">{h.providerInstanceId}</span>
            </span>
            <Badge variant="warning">{t("badge")}</Badge>
            <span className="shrink-0 text-right text-sm tabular-nums text-muted">{t("avgCpu", { pct: h.averageCpuPct.toFixed(1) })}</span>
          </Link>
        </m.li>
      ))}
    </ul>
  );
}
