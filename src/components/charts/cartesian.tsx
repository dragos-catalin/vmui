"use client";

import { useReducedMotionConfig } from "motion/react";
import { useFormatter } from "next-intl";
import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard, type ChartCardProps } from "./chart-card";
import { asChartData, AXIS_TICK, CHART_MARGIN, ChartDataTable, ChartLegend, ChartTooltip, formatValue, type ChartSeries } from "./primitives";
import { toneColor, useChartTheme, type ChartTone } from "./theme";

export interface AnomalyMarker {
  x: string | number;
  y: number;
  label?: string;
  tone?: ChartTone;
}

export interface ReferenceMarker {
  y: number;
  label?: string;
  tone?: ChartTone;
}

export interface CartesianChartProps<T extends object> extends Omit<ChartCardProps, "children" | "empty"> {
  data: T[];
  x: keyof T & string;
  series: ChartSeries<keyof T & string>[];
  stacked?: boolean;
  unit?: string;
  /** Fixed Y domain, e.g. `[0, 100]` for percentages. */
  yDomain?: [number, number];
  xFormatter?: (v: string | number) => string;
  showLegend?: boolean;
  /** Accessible summary of the chart (used for aria-label and the sr-only table caption). */
  ariaLabel: string;
  markers?: AnomalyMarker[];
  referenceLines?: ReferenceMarker[];
}

function useAxes<T extends object>(props: CartesianChartProps<T>) {
  const theme = useChartTheme();
  const format = useFormatter();
  const tick = AXIS_TICK(theme);
  const xAxis = (
    // padding.left + tickMargin keep the first date label clear of the lowest Y label in the corner.
    <XAxis dataKey={props.x as string} tick={tick} tickLine={false} axisLine={{ stroke: theme.grid }} tickFormatter={props.xFormatter} minTickGap={24} tickMargin={6} padding={{ left: 12, right: 8 }} />
  );
  const yAxis = (
    <YAxis
      tick={tick}
      tickLine={false}
      axisLine={false}
      width="auto"
      domain={props.yDomain}
      tickFormatter={(v: number) => formatValue(format, v, props.unit)}
    />
  );
  const grid = <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />;
  const tooltip = <Tooltip content={(p) => <ChartTooltip active={p.active} payload={p.payload} label={p.label} unit={props.unit} />} cursor={{ stroke: theme.grid }} />;
  const legend = props.showLegend !== false && props.series.length > 1 ? <Legend content={(p) => <ChartLegend payload={p.payload} />} /> : null;
  const extras = (
    <>
      {props.referenceLines?.map((r, i) => (
        <ReferenceLine
          key={`ref-${i}`}
          y={r.y}
          stroke={toneColor(theme, r.tone ?? "warning", i)}
          strokeDasharray="4 4"
          label={r.label ? { value: r.label, fill: theme.axis, fontSize: 11, position: i % 2 ? "insideBottomLeft" : "insideTopRight", dy: i % 2 ? 14 : -4 } : undefined}
        />
      ))}
      {props.markers?.map((m, i) => (
        <ReferenceDot key={`dot-${i}`} x={m.x} y={m.y} r={5} fill={toneColor(theme, m.tone ?? "danger", i)} stroke={theme.tooltipBg} strokeWidth={2} label={m.label ? { value: m.label, fill: theme.axis, fontSize: 11, position: "top" } : undefined} />
      ))}
    </>
  );
  const animate = !useReducedMotionConfig() && props.data.length <= 200;
  return { theme, xAxis, yAxis, grid, tooltip, legend, extras, animate };
}

function cardProps<T extends object>(p: CartesianChartProps<T>) {
  const { title, description, action, height, loading, emptyTitle, error, onRetry, className } = p;
  return { title, description, action, height, loading, emptyTitle, error, onRetry, className, empty: p.data.length === 0 };
}

export function AreaChartCard<T extends object>(props: CartesianChartProps<T>) {
  const { theme, xAxis, yAxis, grid, tooltip, legend, extras, animate } = useAxes(props);
  const gradId = React.useId();
  return (
    <ChartCard {...cardProps(props)}>
      <div role="img" aria-label={props.ariaLabel} className="h-full w-full">
        <AreaChart responsive data={asChartData(props.data)} margin={CHART_MARGIN} style={{ width: "100%", height: "100%" }}>
          <defs>
            {props.series.map((s, i) => {
              const c = toneColor(theme, s.tone, i);
              return (
                <linearGradient key={s.key} id={`${gradId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={c} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {props.series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key as string}
              name={s.label}
              stackId={props.stacked ? "stack" : undefined}
              stroke={toneColor(theme, s.tone, i)}
              strokeWidth={1.75}
              fill={`url(#${gradId}-${s.key})`}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={animate}
              animationDuration={300}
              connectNulls
            />
          ))}
          {extras}
        </AreaChart>
      </div>
      <ChartDataTable data={props.data} x={props.x} series={props.series} caption={props.ariaLabel} unit={props.unit} />
    </ChartCard>
  );
}

export function LineChartCard<T extends object>(props: CartesianChartProps<T>) {
  const { theme, xAxis, yAxis, grid, tooltip, legend, extras, animate } = useAxes(props);
  return (
    <ChartCard {...cardProps(props)}>
      <div role="img" aria-label={props.ariaLabel} className="h-full w-full">
        <LineChart responsive data={asChartData(props.data)} margin={CHART_MARGIN} style={{ width: "100%", height: "100%" }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {props.series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key as string}
              name={s.label}
              stroke={toneColor(theme, s.tone, i)}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={animate}
              animationDuration={300}
              connectNulls
            />
          ))}
          {extras}
        </LineChart>
      </div>
      <ChartDataTable data={props.data} x={props.x} series={props.series} caption={props.ariaLabel} unit={props.unit} />
    </ChartCard>
  );
}

export function BarChartCard<T extends object>(props: CartesianChartProps<T> & { horizontal?: boolean }) {
  const { theme, xAxis, yAxis, grid, tooltip, legend, extras, animate } = useAxes(props);
  return (
    <ChartCard {...cardProps(props)}>
      <div role="img" aria-label={props.ariaLabel} className="h-full w-full">
        <BarChart responsive data={asChartData(props.data)} margin={CHART_MARGIN} style={{ width: "100%", height: "100%" }} barCategoryGap="20%">
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {props.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key as string}
              name={s.label}
              stackId={props.stacked ? "stack" : undefined}
              fill={toneColor(theme, s.tone, i)}
              radius={props.stacked ? 0 : [4, 4, 0, 0]}
              isAnimationActive={animate}
              animationDuration={300}
            />
          ))}
          {extras}
        </BarChart>
      </div>
      <ChartDataTable data={props.data} x={props.x} series={props.series} caption={props.ariaLabel} unit={props.unit} />
    </ChartCard>
  );
}
