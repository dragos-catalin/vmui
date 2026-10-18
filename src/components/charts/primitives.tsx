"use client";

import { cn } from "@/lib/utils";
import { useFormatter } from "next-intl";
import * as React from "react";
import type { LegendPayload, TooltipContentProps } from "recharts";
import type { ChartTheme } from "./theme";

export type ChartDatum = Record<string, string | number | null | undefined>;

/** recharts resolves `dataKey` against its own inferred data type; we feed it a loose row shape. */
export const asChartData = (rows: readonly object[]): ChartDatum[] => rows as ChartDatum[];

export interface ChartSeries<K extends string = string> {
  key: K;
  label: string;
  tone?: import("./theme").ChartTone;
}

export function formatValue(format: ReturnType<typeof useFormatter>, v: unknown, unit?: string): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  const n = format.number(v, { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 });
  return unit ? `${n}${unit.length <= 1 ? "" : " "}${unit}` : n;
}

export function ChartTooltip({
  active,
  payload,
  label,
  unit,
  labelFormatter,
}: Pick<TooltipContentProps, "active" | "payload" | "label"> & {
  unit?: string;
  labelFormatter?: (label: string | number | undefined) => React.ReactNode;
}) {
  const format = useFormatter();
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="glass min-w-[8rem] rounded-[var(--radius-md)] border border-border px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="mb-1 font-medium text-fg">{labelFormatter ? labelFormatter(label) : String(label)}</p>}
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={`${String(p.dataKey ?? p.name ?? i)}`} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-fg-muted">
              <span className="size-2 shrink-0 rounded-full" style={{ background: p.color ?? "var(--color-primary)" }} aria-hidden />
              <span className="truncate">{String(p.name ?? p.dataKey ?? "")}</span>
            </span>
            <span className="tabular-nums text-fg">{formatValue(format, p.value, unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartLegend({ payload, className }: { payload?: readonly LegendPayload[]; className?: string }) {
  if (!payload || payload.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-2 text-2xs text-fg-muted", className)}>
      {payload.map((p, i) => (
        <li key={`${String(p.dataKey ?? p.value ?? i)}`} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: p.color ?? "var(--color-primary)" }} aria-hidden />
          <span className="truncate">{String(p.value ?? "")}</span>
        </li>
      ))}
    </ul>
  );
}

/** Screen-reader alternative for small datasets. */
export function ChartDataTable<T extends object>({
  data,
  x,
  series,
  caption,
  unit,
}: {
  data: T[];
  x: keyof T & string;
  series: ChartSeries[];
  caption: string;
  unit?: string;
}) {
  const format = useFormatter();
  if (data.length === 0 || data.length > 50) return null;
  const rows = data as unknown as ChartDatum[];
  return (
    // The wrapper carries sr-only: a <table> ignores the 1px width (min-content wins) and would widen the page.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{x}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <th scope="row">{String(row[x] ?? "")}</th>
              {series.map((s) => (
                <td key={s.key}>{formatValue(format, row[s.key], unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const AXIS_TICK = (theme: ChartTheme) => ({ fill: theme.axis, fontSize: 11 });
export const CHART_MARGIN = { top: 8, right: 8, left: 0, bottom: 0 } as const;
