"use client";

import { LineChartCard } from "./lazy-charts";
import { Badge, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import type { AnomalyPoint } from "@/lib/cost-anomaly";
import { CheckCircle2 } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

export function AnomaliesView({ points, mean, threshold, stdDev }: { points: AnomalyPoint[]; mean: number; threshold: number; stdDev: number }) {
  const t = useTranslations("observe.anomalies");
  const format = useFormatter();
  const anomalies = React.useMemo(() => points.filter((p) => p.isAnomaly).slice().reverse(), [points]);
  const data = React.useMemo(() => points.map((p) => ({ day: p.day, usd: p.usd })), [points]);

  const columns: ColumnDef<AnomalyPoint>[] = React.useMemo(
    () => [
      {
        id: "day",
        header: t("columns.day"),
        cell: ({ row }) => <time dateTime={row.original.day}>{format.dateTime(new Date(row.original.day), { dateStyle: "medium" })}</time>,
      },
      {
        id: "usd",
        header: t("columns.spend"),
        cell: ({ row }) => <span className="tabular-nums">{format.number(row.original.usd, { style: "currency", currency: "USD" })}</span>,
      },
      {
        id: "z",
        header: t("columns.zScore"),
        cell: ({ row }) => (
          <Badge variant={row.original.zScore > 0 ? "danger" : "info"}>
            z = {format.number(row.original.zScore, { maximumFractionDigits: 2, signDisplay: "always" })}
          </Badge>
        ),
      },
      {
        id: "delta",
        header: t("columns.vsMean"),
        cell: ({ row }) => (
          <span className="tabular-nums text-xs text-fg-muted">
            {format.number(row.original.usd - mean, { style: "currency", currency: "USD", signDisplay: "always" })}
          </span>
        ),
      },
    ],
    [t, format, mean],
  );

  return (
    <div className="space-y-4">
      <LineChartCard
        title={t("chart.title")}
        description={t("chart.description", { threshold: format.number(threshold, { maximumFractionDigits: 1 }) })}
        data={points.length < 3 ? [] : data}
        x="day"
        series={[{ key: "usd", label: t("columns.spend"), tone: "primary" }]}
        unit="$"
        xFormatter={(v) => format.dateTime(new Date(String(v)), { month: "short", day: "2-digit" })}
        ariaLabel={t("chart.aria")}
        emptyTitle={t("chart.needMore")}
        height={240}
        referenceLines={[
          { y: mean, label: t("chart.mean"), tone: "info" },
          { y: mean + threshold * stdDev, label: t("chart.upper"), tone: "warning" },
        ]}
        markers={points.filter((p) => p.isAnomaly).map((p) => ({ x: p.day, y: p.usd, tone: p.zScore > 0 ? "danger" : "info" }))}
      />

      <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
        <DataTable
          columns={columns}
          data={anomalies}
          dense
          getRowId={(r) => r.day}
          emptyState={<EmptyState compact icon={<CheckCircle2 />} title={t("empty.title")} description={t("empty.description")} />}
        />
      </m.div>
    </div>
  );
}
