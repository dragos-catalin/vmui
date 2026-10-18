"use client";

import type { AreaChartCard as AreaT, BarChartCard as BarT, LineChartCard as LineT } from "@/components/charts/cartesian";
import type { DonutCard as DonutT } from "@/components/charts/donut";
import { Skeleton } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";

// recharts-backed cards, code-split so routes that show a chart below the fold
// do not ship recharts in their first-load JS. Same props as the originals;
// the fallback matches ChartCard's default footprint (header + 220 px body).
// HeatmapGrid is plain DOM: import it from "@/components/charts/heatmap".

function ChartSkeleton() {
  return <Skeleton className="h-[17rem] w-full rounded-[var(--radius-lg)]" aria-hidden />;
}

export const LineChartCard = dynamic(() => import("@/components/charts/cartesian").then((mod) => mod.LineChartCard), {
  ssr: false,
  loading: ChartSkeleton,
}) as typeof LineT;

export const AreaChartCard = dynamic(() => import("@/components/charts/cartesian").then((mod) => mod.AreaChartCard), {
  ssr: false,
  loading: ChartSkeleton,
}) as typeof AreaT;

export const BarChartCard = dynamic(() => import("@/components/charts/cartesian").then((mod) => mod.BarChartCard), {
  ssr: false,
  loading: ChartSkeleton,
}) as typeof BarT;

export const DonutCard = dynamic(() => import("@/components/charts/donut").then((mod) => mod.DonutCard), {
  ssr: false,
  loading: ChartSkeleton,
}) as typeof DonutT;
