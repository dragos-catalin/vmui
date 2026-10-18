import { cn } from "@/lib/utils";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import * as React from "react";
import { SkeletonStat } from "./skeleton";

export type StatTone = "default" | "success" | "warning" | "danger" | "info";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-fg",
  success: "text-[color-mix(in_oklch,var(--color-success)_75%,var(--color-fg))]",
  warning: "text-warning-text",
  danger: "text-[color-mix(in_oklch,var(--color-danger)_80%,var(--color-fg))]",
  info: "text-primary-text",
};

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = "default",
  trend,
  loading = false,
  compact = false,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: StatTone;
  trend?: { delta: number; label?: React.ReactNode };
  loading?: boolean;
  /** Tighter padding and a smaller value on phones (3-up grids). */
  compact?: boolean;
  className?: string;
}) {
  if (loading) return <SkeletonStat className={className} />;
  const TrendIcon = trend ? (trend.delta > 0 ? TrendingUp : trend.delta < 0 ? TrendingDown : Minus) : null;
  const trendTone = trend ? (trend.delta > 0 ? VALUE_TONE.success : trend.delta < 0 ? VALUE_TONE.danger : "text-fg-muted") : "";
  return (
    <div className={cn("surface flex min-w-0 flex-col gap-2", compact ? "p-3 sm:p-5" : "p-4 sm:p-5", className)}>
      <div className="flex items-start justify-between gap-2">
        <span className={cn("min-w-0 uppercase tracking-wider text-fg-muted", compact ? "text-2xs sm:text-xs" : "text-xs")}>{label}</span>
        {icon && (
          <span className={cn("shrink-0 text-fg-muted [&>svg]:size-4", compact && "hidden sm:inline")} aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <div className={cn("font-display font-semibold leading-none tabular-nums", compact ? "text-lg sm:text-2xl" : "text-2xl", VALUE_TONE[tone])}>{value}</div>
      {(trend || hint) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          {trend && TrendIcon && (
            <span className={cn("inline-flex items-center gap-1 font-medium tabular-nums", trendTone)}>
              <TrendIcon className="size-3.5" aria-hidden />
              {trend.delta > 0 ? "+" : ""}
              {trend.delta}
              {trend.label && <span className="font-normal text-fg-muted">{trend.label}</span>}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}

const COLS: Record<2 | 3 | 4 | 5, string> = {
  2: "xl:grid-cols-2",
  3: "xl:grid-cols-3",
  4: "xl:grid-cols-4",
  5: "xl:grid-cols-5",
};

export function StatGrid({ children, cols = 4, className }: { children: React.ReactNode; cols?: 2 | 3 | 4 | 5; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", COLS[cols], className)}>{children}</div>;
}
