"use client";

import { HeatmapGrid } from "@/components/charts/heatmap";
import { EmptyState } from "@/components/ui";
import { Grid3x3 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

export interface SpendCell {
  dow: number;
  hour: number;
  mean: number;
  n: number;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DOWS = [0, 1, 2, 3, 4, 5, 6];
// Any Sunday in UTC; only the weekday label is read from it.
const SUNDAY_UTC = Date.UTC(2024, 0, 7);

export function SpendHeatmapGrid({ cells, max }: { cells: SpendCell[]; max: number }) {
  const t = useTranslations("cloud.spendHeatmap");
  const format = useFormatter();
  if (cells.length === 0) {
    return <EmptyState illustration="costs" icon={<Grid3x3 />} title={t("empty.title")} description={t("empty.description")} />;
  }
  const usd = (n: number) => format.number(n, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const dayLabel = (dow: number) => format.dateTime(new Date(SUNDAY_UTC + dow * 86_400_000), { weekday: "short", timeZone: "UTC" });
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  const values = DOWS.map((dow) => HOURS.map((h) => byKey.get(`${dow}:${h}`)?.mean ?? null));

  return (
    <div className="surface overflow-x-auto p-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] xl:[mask-image:none]">
      <HeatmapGrid
        rows={DOWS.map(dayLabel)}
        cols={HOURS.map(String)}
        values={values}
        max={max > 0 ? max : undefined}
        showColLabels
        cellClassName="h-6"
        className="min-w-[40rem]"
        ariaLabel={t("aria")}
        label={(r, c, v) => {
          const cell = byKey.get(`${r}:${c}`);
          return t("cell", { day: dayLabel(r), hour: c, amount: usd(v ?? 0), count: cell?.n ?? 0 });
        }}
      />
      <p className="mt-3 text-xs text-fg-muted">{t("legend", { amount: usd(max) })}</p>
    </div>
  );
}
