import { cn } from "@/lib/utils";
import * as React from "react";

export type ProgressTone = "default" | "success" | "warning" | "danger" | "info";

const BAR_TONE: Record<ProgressTone, string> = {
  default: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function Progress({
  value,
  max = 100,
  label,
  tone = "default",
  size = "md",
  indeterminate = false,
  className,
  "aria-label": ariaLabel,
  valueText,
}: {
  value?: number;
  max?: number;
  /** Visible label. Give either this or `aria-label`: an unlabelled progressbar is announced as just a number. */
  label?: React.ReactNode;
  "aria-label"?: string;
  /** Spoken value (`aria-valuetext`); defaults to the rounded percentage. */
  valueText?: string;
  tone?: ProgressTone;
  size?: "sm" | "md";
  indeterminate?: boolean;
  className?: string;
}) {
  const clamped = Math.min(max, Math.max(0, value ?? 0));
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  const labelId = React.useId();
  if (process.env.NODE_ENV !== "production" && !label && !ariaLabel) {
    console.warn("[Progress] missing `label` or `aria-label`");
  }
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      {label && (
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span id={labelId} className="min-w-0">{label}</span>
          {!indeterminate && <span className="shrink-0 tabular-nums" aria-hidden>{Math.round(pct)}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={indeterminate ? undefined : (valueText ?? `${Math.round(pct)}%`)}
        aria-busy={indeterminate || undefined}
        className={cn("relative w-full overflow-hidden rounded-full bg-bg-muted", size === "sm" ? "h-1.5" : "h-2.5")}
      >
        {indeterminate ? (
          <div className="skeleton h-full w-full rounded-full" />
        ) : (
          <div
            className={cn("h-full rounded-full transition-[width] duration-[var(--duration-slow)] ease-[var(--ease-out)]", BAR_TONE[tone])}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
