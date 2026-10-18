"use client";

import { ProviderName } from "@/components/cloud/provider-tile";
import { Badge, Button } from "@/components/ui";
import { ArrowDownRight, ExternalLink, Gauge, Power, Zap } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type * as React from "react";
import { useMoney } from "./use-money";

export interface RecommendationCardData {
  id: string;
  kind: string;
  confidence: string;
  instanceId: string;
  instanceName: string | null;
  instanceType: string | null;
  provider: string;
  region: string;
  summary: string;
  suggestedInstanceType: string | null;
  observedCpuP95: number | null;
  lookbackHours: number | null;
  estMonthlySavingsUsd: number | null;
}

type KindKey = "rightsize" | "idle" | "stop-after-hours" | "spot-eligible";
const KINDS: readonly KindKey[] = ["rightsize", "idle", "stop-after-hours", "spot-eligible"];

const KIND_META: Record<KindKey, { tone: "info" | "warning" | "muted" | "success"; Icon: React.ComponentType<{ className?: string }> }> = {
  rightsize: { tone: "info", Icon: ArrowDownRight },
  idle: { tone: "warning", Icon: Power },
  "stop-after-hours": { tone: "muted", Icon: Gauge },
  "spot-eligible": { tone: "success", Icon: Zap },
};

const MAX_ANIMATED = 12;

function isKind(k: string): k is KindKey {
  return (KINDS as readonly string[]).includes(k);
}

export function RecommendationCards({ rows }: { rows: RecommendationCardData[] }) {
  const t = useTranslations("cloud.recommendations");
  const { usd } = useMoney();

  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((r, i) => {
        const kind = isKind(r.kind) ? r.kind : null;
        const meta = kind ? KIND_META[kind] : { tone: "muted" as const, Icon: Gauge };
        const href = `/instances/${encodeURIComponent(r.instanceId)}`;
        const days = Math.round((r.lookbackHours ?? 0) / 24);
        return (
          <m.li
            key={r.id}
            initial={i < MAX_ANIMATED ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i, MAX_ANIMATED) * 0.03 }}
            className="surface card-hover flex min-w-0 flex-col gap-3 p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={meta.tone}>
                <meta.Icon className="size-3" aria-hidden />
                {kind ? t(`kind.${kind}`) : r.kind}
              </Badge>
              {(r.confidence === "low" || r.confidence === "medium" || r.confidence === "high") && (
                <span className="text-[11px] text-muted">{t(`confidence.${r.confidence}`)}</span>
              )}
            </div>

            <div className="min-w-0">
              <Link href={href} className="block truncate text-sm font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {r.instanceName ?? r.instanceId}
              </Link>
              <p className="truncate text-xs text-muted">
                <ProviderName provider={r.provider} />
                {r.region && ` · ${r.region}`}
                {r.instanceType && (
                  <>
                    {" · "}
                    <span className="font-mono">{r.instanceType}</span>
                  </>
                )}
              </p>
            </div>

            <p className="text-sm text-muted">{r.summary}</p>

            <div className="mt-auto flex items-end justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                {r.estMonthlySavingsUsd != null && (
                  <>
                    <div className="text-[11px] uppercase tracking-wider text-muted">{t("card.saving")}</div>
                    <div className="text-lg font-semibold leading-tight tabular-nums text-success">
                      {t("card.perMonth", { amount: usd(r.estMonthlySavingsUsd) })}
                    </div>
                  </>
                )}
                {r.suggestedInstanceType && <div className="truncate font-mono text-[11px] text-muted">{t("card.suggested", { type: r.suggestedInstanceType })}</div>}
                {r.observedCpuP95 != null && <div className="text-[11px] text-muted">{t("card.cpuHint", { pct: r.observedCpuP95.toFixed(1), days })}</div>}
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={href}>
                  {t("card.open")}
                  <ExternalLink className="size-3.5" aria-hidden />
                </Link>
              </Button>
            </div>
          </m.li>
        );
      })}
    </ul>
  );
}
