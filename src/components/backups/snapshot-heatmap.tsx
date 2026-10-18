"use client";

import type { SnapshotEvent } from "@/server/queries/snapshots";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = 26;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const LEVEL_BG = [
  "color-mix(in oklch, var(--color-surface-muted) 70%, transparent)",
  "color-mix(in oklch, var(--color-primary) 22%, transparent)",
  "color-mix(in oklch, var(--color-primary) 45%, transparent)",
  "color-mix(in oklch, var(--color-primary) 70%, transparent)",
  "var(--color-primary)",
] as const;

/** GitHub-style 26-week heatmap. Columns = weeks, rows = weekdays. */
export function SnapshotHeatmap({ events }: { events: SnapshotEvent[] }) {
  const t = useTranslations("ops.backups.heatmap");
  const format = useFormatter();

  const { grid, max, monthLabels } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      const k = dayKey(e.capturedAt);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayDow = today.getUTCDay();
    const lastSunday = new Date(today.getTime() - todayDow * DAY_MS);
    const start = new Date(lastSunday.getTime() - (WEEKS - 1) * 7 * DAY_MS);

    const grid: { date: Date; key: string; count: number }[][] = [];
    const monthLabels: { col: number; date: Date }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const col: { date: Date; key: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getTime() + (w * 7 + d) * DAY_MS);
        const key = dayKey(date.getTime());
        col.push({ date, key, count: counts.get(key) ?? 0 });
      }
      const first = col[0];
      const m = first?.date.getUTCMonth() ?? 0;
      if (first && m !== lastMonth) {
        monthLabels.push({ col: w, date: first.date });
        lastMonth = m;
      }
      grid.push(col);
    }
    let max = 0;
    for (const v of counts.values()) if (v > max) max = v;
    return { grid, max, monthLabels };
  }, [events]);

  const intensity = (count: number) => {
    if (count === 0 || max === 0) return 0;
    const r = count / max;
    if (r >= 0.85) return 4;
    if (r >= 0.55) return 3;
    if (r >= 0.25) return 2;
    return 1;
  };
  const colorFor = (level: number) => LEVEL_BG[level] ?? LEVEL_BG[0];
  const weekdayLetters = [1, 3, 5].map((dow) => format.dateTime(new Date(Date.UTC(2024, 0, 7 + dow)), { weekday: "narrow", timeZone: "UTC" }));

  return (
    <div
      role="region"
      aria-label={t("ariaLabel", { weeks: WEEKS })}
      tabIndex={0}
      className="overflow-x-auto rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="inline-block">
        <div className="mb-1 ml-7 grid" style={{ gridTemplateColumns: `repeat(${WEEKS}, 14px)`, gap: "2px" }}>
          {monthLabels.map((m) => (
            <div key={m.col} className="text-[10px] text-fg-muted" style={{ gridColumnStart: m.col + 1 }}>
              {format.dateTime(m.date, { month: "short", timeZone: "UTC" })}
            </div>
          ))}
        </div>
        <div className="flex">
          <div className="mr-1 grid grid-rows-7 gap-[2px] text-[9px] text-fg-muted" aria-hidden>
            {["", weekdayLetters[0], "", weekdayLetters[1], "", weekdayLetters[2], ""].map((l, i) => (
              <div key={i} className="h-[14px] leading-[14px]">
                {l}
              </div>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${WEEKS}, 14px)`, gap: "2px" }} role="img" aria-label={t("ariaLabel", { weeks: WEEKS })}>
            {grid.map((col, w) => (
              <div key={w} className="grid grid-rows-7 gap-[2px]">
                {col.map((cell) => (
                  <div
                    key={cell.key}
                    title={t("cellTitle", { date: cell.key, count: cell.count })}
                    className="h-[14px] w-[14px] rounded-[3px] border border-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] transition-transform hover:scale-125"
                    style={{ background: colorFor(intensity(cell.count)) }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[10px] text-fg-muted">
          <span>{t("less")}</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <div
              key={l}
              className="h-[10px] w-[10px] rounded-[2px] border border-[color-mix(in_oklch,var(--color-fg)_6%,transparent)]"
              style={{ background: colorFor(l) }}
              aria-hidden
            />
          ))}
          <span>{t("more", { max })}</span>
        </div>
      </div>
    </div>
  );
}
