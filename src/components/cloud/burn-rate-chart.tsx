"use client";

import type { AnomalyMarker } from "@/components/charts";
import { LineChartCard } from "@/components/monitoring/lazy-charts";
import { useFormatter, useTranslations } from "next-intl";

export interface BurnDay {
  day: string;
  daily: number;
}

export function BurnRateChart({ days, threshold }: { days: BurnDay[]; threshold: number }) {
  const t = useTranslations("cloud.burnRate");
  const format = useFormatter();
  const markers: AnomalyMarker[] = threshold > 0 ? days.filter((d) => d.daily > threshold).map((d) => ({ x: d.day, y: d.daily, tone: "danger" })) : [];
  return (
    <LineChartCard
      title={t("chart.title")}
      description={t("chart.description")}
      emptyTitle={t("empty.title")}
      data={days}
      x="day"
      unit="USD"
      xFormatter={(v) => format.dateTime(new Date(String(v)), { day: "numeric", month: "short" })}
      series={[{ key: "daily", label: t("chart.legendBurn"), tone: "primary" }]}
      referenceLines={threshold > 0 ? [{ y: threshold, label: t("chart.legendThreshold"), tone: "danger" }] : undefined}
      markers={markers}
      ariaLabel={t("chart.aria", { count: days.length })}
    />
  );
}
