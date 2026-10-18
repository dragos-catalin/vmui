"use client";

import { HeatmapGrid } from "@/components/charts/heatmap";
import { DonutCard } from "./lazy-charts";
import { Badge, Stat, StatGrid } from "@/components/ui";
import { CheckCircle2, XCircle } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";

export interface StatusBoardProps {
  healthy: boolean;
  generatedAt: number;
  totalInstances: number;
  running: number;
  stopped: number;
  fleetHourlyUsd: number;
  recentErrors24h: number;
  byProvider: { name: string; value: number }[];
  /** 30 daily buckets, oldest first; `null` = no data for that day. */
  uptime: { day: string; okRatio: number | null }[];
  signature: string;
}

export function StatusBoard(p: StatusBoardProps) {
  const t = useTranslations("observe.status");
  const format = useFormatter();
  return (
    <div className="space-y-6">
      <m.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="surface flex flex-col items-center gap-2 p-6 text-center"
      >
        <Badge variant={p.healthy ? "success" : "danger"} className="px-4 py-1 text-sm">
          {p.healthy ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
          {p.healthy ? t("operational") : t("degraded")}
        </Badge>
        <p className="text-xs text-fg-muted">
          {t("generatedAt", { when: format.dateTime(new Date(p.generatedAt), { dateStyle: "medium", timeStyle: "short" }) })}
        </p>
      </m.div>

      <StatGrid cols={4}>
        <Stat label={t("stats.instances")} value={p.totalInstances} />
        <Stat label={t("stats.running")} value={p.running} tone="success" />
        <Stat label={t("stats.stopped")} value={p.stopped} />
        <Stat label={t("stats.hourly")} value={format.number(p.fleetHourlyUsd, { style: "currency", currency: "USD" })} />
      </StatGrid>

      <section aria-labelledby="uptime-title" className="surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="uptime-title" className="text-sm font-semibold">
            {t("uptime.title")}
          </h2>
          <span className="text-xs text-fg-muted">{t("uptime.errors24h", { count: p.recentErrors24h })}</span>
        </div>
        <HeatmapGrid
          rows={[t("uptime.row")]}
          cols={p.uptime.map((u) => u.day)}
          values={[p.uptime.map((u) => u.okRatio)]}
          max={1}
          tone="success"
          cellClassName="h-8"
          showRowLabels={false}
          ariaLabel={t("uptime.aria")}
          label={(_r, c, v) => {
            const d = p.uptime[c];
            const day = d ? format.dateTime(new Date(d.day), { dateStyle: "medium" }) : "";
            return v === null || v === undefined ? t("uptime.noData", { day }) : t("uptime.cell", { day, pct: format.number(v, { style: "percent", maximumFractionDigits: 1 }) });
          }}
        />
        <div className="mt-1 flex justify-between text-[10px] text-fg-muted">
          <span>{t("uptime.daysAgo", { n: p.uptime.length })}</span>
          <span>{t("uptime.today")}</span>
        </div>
      </section>

      <DonutCard
        title={t("byProvider")}
        data={p.byProvider}
        totalLabel={t("stats.instances")}
        ariaLabel={t("byProviderAria")}
        emptyTitle={t("noInstances")}
      />

      <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[11px] text-fg-muted">
        <span>{t("signature")}</span>
        <code className="break-all font-mono">{p.signature}</code>
        <span aria-hidden>·</span>
        <code className="break-all font-mono">HMAC-SHA256(VMUI_MASTER_KEY, payload)</code>
      </footer>
    </div>
  );
}
