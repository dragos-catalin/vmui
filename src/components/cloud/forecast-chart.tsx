"use client";

import { LineChartCard } from "@/components/monitoring/lazy-charts";
import { useFormatter, useTranslations } from "next-intl";

export interface ForecastPoint {
  day: string;
  actualUsd: number | null;
  projectedUsd: number | null;
}

export function ForecastChart({ points }: { points: ForecastPoint[] }) {
  const t = useTranslations("cloud.forecast");
  const format = useFormatter();
  return (
    <LineChartCard
      title={t("chart.title")}
      description={t("chart.description")}
      emptyTitle={t("empty.title")}
      data={points}
      x="day"
      unit="USD"
      xFormatter={(v) => format.dateTime(new Date(String(v)), { day: "numeric", month: "short" })}
      series={[
        { key: "actualUsd", label: t("chart.actual"), tone: "primary" },
        { key: "projectedUsd", label: t("chart.projected"), tone: "accent" },
      ]}
      ariaLabel={t("chart.aria", { count: points.length })}
    />
  );
}
