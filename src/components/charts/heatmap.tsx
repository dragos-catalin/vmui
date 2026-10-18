"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

export interface HeatmapGridProps {
  rows: string[];
  cols: string[];
  /** values[r][c]; `null`/`undefined` renders as "no data". */
  values: (number | null | undefined)[][];
  label: (r: number, c: number, value: number | null | undefined) => string;
  max?: number;
  /** Cell size class, e.g. `h-3` for a slim uptime strip. */
  cellClassName?: string;
  showRowLabels?: boolean;
  showColLabels?: boolean;
  /** Colour used for the filled cells; defaults to primary. */
  tone?: "primary" | "success" | "warning" | "danger";
  ariaLabel: string;
  className?: string;
}

export function HeatmapGrid({ rows, cols, values, label, max, cellClassName = "h-6", showRowLabels = true, showColLabels = false, tone = "primary", ariaLabel, className }: HeatmapGridProps) {
  const computedMax = React.useMemo(() => {
    if (max !== undefined) return max;
    let m = 0;
    for (const row of values) for (const v of row) if (typeof v === "number" && v > m) m = v;
    return m || 1;
  }, [values, max]);
  const toneVar = `var(--color-${tone})`;
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      className={cn("min-w-0 overflow-x-auto rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}
    >
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `${showRowLabels ? "auto " : ""}repeat(${cols.length}, minmax(0.5rem, 1fr))` }}
      >
        {showColLabels && (
          <>
            {showRowLabels && <span aria-hidden />}
            {cols.map((c) => (
              <span key={c} className="truncate text-center text-2xs text-fg-muted" aria-hidden>
                {c}
              </span>
            ))}
          </>
        )}
        {rows.map((r, ri) => (
          <React.Fragment key={r}>
            {showRowLabels && (
              <span className="self-center pr-2 text-xs text-fg-muted" aria-hidden>
                {r}
              </span>
            )}
            {cols.map((c, ci) => {
              const v = values[ri]?.[ci];
              const pct = typeof v === "number" ? Math.max(0, Math.min(100, Math.round((v / computedMax) * 100))) : null;
              const text = label(ri, ci, v);
              return (
                <span
                  key={`${r}-${c}`}
                  role="img"
                  title={text}
                  aria-label={text}
                  className={cn("block min-w-2 rounded-[2px]", cellClassName)}
                  style={{
                    background: pct === null ? "var(--color-bg-muted)" : `color-mix(in oklch, ${toneVar} ${Math.max(pct, 8)}%, var(--color-bg-muted))`,
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
