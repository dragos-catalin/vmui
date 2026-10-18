"use client";

import { useReducedMotionConfig } from "motion/react";
import { useFormatter } from "next-intl";
import * as React from "react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { ChartCard, type ChartCardProps } from "./chart-card";
import { ChartTooltip } from "./primitives";
import { toneColor, useChartTheme, type ChartTone } from "./theme";

export interface DonutDatum {
  name: string;
  value: number;
  tone?: ChartTone;
}

export interface DonutCardProps extends Omit<ChartCardProps, "children" | "empty"> {
  data: DonutDatum[];
  /** Big number in the middle; defaults to the sum. */
  total?: React.ReactNode;
  totalLabel?: React.ReactNode;
  unit?: string;
  ariaLabel: string;
}

export function DonutCard({ data, total, totalLabel, unit, ariaLabel, ...card }: DonutCardProps) {
  const theme = useChartTheme();
  const format = useFormatter();
  const reduced = useReducedMotionConfig();
  const sum = data.reduce((a, d) => a + d.value, 0);
  const height = card.height ?? 220;
  return (
    <ChartCard {...card} height={height} empty={data.length === 0 || sum === 0}>
      <div className="flex h-full min-w-0 flex-col items-center gap-4 sm:flex-row">
        <div role="img" aria-label={ariaLabel} className="relative h-full w-full max-w-[var(--donut-size)] shrink-0 sm:w-[var(--donut-size)]" style={{ "--donut-size": `${height}px` } as React.CSSProperties}>
          <PieChart responsive style={{ width: "100%", height: "100%" }}>
            <Tooltip content={(p) => <ChartTooltip active={p.active} payload={p.payload} unit={unit} />} />
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="95%" paddingAngle={2} strokeWidth={0} isAnimationActive={!reduced} animationDuration={300}>
              {data.map((d, i) => (
                <Cell key={d.name} fill={toneColor(theme, d.tone, i)} />
              ))}
            </Pie>
          </PieChart>
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="text-xl font-semibold tabular-nums leading-none">{total ?? format.number(sum)}</div>
              {totalLabel && <div className="mt-1 text-2xs uppercase tracking-wider text-fg-muted">{totalLabel}</div>}
            </div>
          </div>
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-1 text-xs">
          {data.map((d, i) => (
            <li key={d.name} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-fg-muted">
                <span className="size-2 shrink-0 rounded-full" style={{ background: toneColor(theme, d.tone, i) }} aria-hidden />
                <span className="truncate" title={d.name}>{d.name}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {format.number(d.value)}
                {sum > 0 && <span className="ml-1 text-fg-muted">({format.number(d.value / sum, { style: "percent", maximumFractionDigits: 0 })})</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}
