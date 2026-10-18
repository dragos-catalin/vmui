"use client";

import { Alert, Badge, Button, PageSection, SkeletonCard, ToggleGroup } from "@/components/ui";
import type { MetricSeries, MetricsHistory } from "@/lib/providers/types";
import { getMetricsHistoryAction } from "@/server/actions/metrics";
import { RefreshCw } from "lucide-react";
import * as Mo from "motion/react-m";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";

interface Props {
  accountId: string;
  providerInstanceId: string;
  /** When false, the panel just shows a hint and never fetches. */
  enabled?: boolean;
}

const RANGES = [
  { id: "30m", key: "range30m", minutes: 30 },
  { id: "1h", key: "range1h", minutes: 60 },
  { id: "6h", key: "range6h", minutes: 360 },
  { id: "24h", key: "range24h", minutes: 1440 },
  { id: "7d", key: "range7d", minutes: 60 * 24 * 7 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

export function MetricsTab({ accountId, providerInstanceId, enabled = true }: Props) {
  const t = useTranslations("vm.metrics");
  const [range, setRange] = useState<RangeId>("1h");
  const [data, setData] = useState<MetricsHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const minutes = RANGES.find((r) => r.id === range)?.minutes ?? 60;

  const reload = () => {
    setError(null);
    start(async () => {
      const r = await getMetricsHistoryAction(accountId, providerInstanceId, minutes);
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
  };

  useEffect(() => {
    if (!enabled) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, providerInstanceId, range, enabled]);

  return (
    <PageSection
      title={
        <span className="inline-flex items-center gap-2">
          {t("title")}
          {data?.source && <Badge variant="muted" className="text-[10px]">{data.source}</Badge>}
        </span>
      }
      description={t("description")}
      action={
        <>
          <ToggleGroup
            size="sm"
            value={range}
            onValueChange={setRange}
            aria-label={t("range")}
            options={RANGES.map((r) => ({ value: r.id, label: t(r.key) }))}
          />
          <Button variant="ghost" size="sm" onClick={reload} loading={pending} aria-label={t("refresh")}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <Alert tone="danger" className="text-xs">
            {error}
          </Alert>
        )}
        {data?.note && (
          <Alert tone="info" className="text-xs">
            {data.note}
          </Alert>
        )}
        {!data && !error && (
          <div className="grid gap-4 sm:grid-cols-2">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}
        {data && (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.series.map((s, i) => (
              <Mo.div
                key={s.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
              >
                <SeriesChart series={s} />
              </Mo.div>
            ))}
          </div>
        )}
      </div>
    </PageSection>
  );
}

function SeriesChart({ series }: { series: MetricSeries }) {
  const t = useTranslations("vm.metrics");
  const points = series.points.filter((p) => p.v != null) as { t: number; v: number }[];
  const last = points[points.length - 1]?.v ?? null;
  const max = useMemo(() => {
    if (points.length === 0) return 1;
    const m = Math.max(...points.map((p) => p.v));
    return m > 0 ? m * 1.1 : 1;
  }, [points]);

  const w = 360;
  const h = 64;
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const t0 = points[0]!.t;
    const tN = points[points.length - 1]!.t;
    const span = Math.max(1, tN - t0);
    return points
      .map((p, i) => {
        const x = ((p.t - t0) / span) * w;
        const y = h - (p.v / max) * (h - 4) - 2;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points, max]);

  const formatted = format(last, series.unit);
  const peakFormatted = format(max / 1.1, series.unit);

  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-[color-mix(in_oklch,var(--color-bg)_60%,transparent)] p-3">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{series.label}</span>
        <span className="font-mono tabular-nums text-muted">
          {formatted} <span className="opacity-60">{t("peak", { value: peakFormatted })}</span>
        </span>
      </div>
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("chart", { label: series.label })}
        className="text-primary"
      >
        <defs>
          <linearGradient id={`grad-${series.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {points.length > 1 ? (
          <>
            <Mo.path
              key={path}
              d={`${path} L${w},${h} L0,${h} Z`}
              fill={`url(#grad-${series.id})`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            />
            <Mo.path
              key={`stroke-${path}`}
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.32, ease: "easeOut" }}
            />
          </>
        ) : (
          <text x={w / 2} y={h / 2} textAnchor="middle" className="fill-[var(--color-fg-muted)]" fontSize="10">
            {t("noData")}
          </text>
        )}
      </svg>
    </div>
  );
}

function format(v: number | null, unit: MetricSeries["unit"]): string {
  if (v == null) return "—";
  if (unit === "percent") return `${v.toFixed(1)}%`;
  if (unit === "bps") return formatBps(v);
  return formatBytes(v);
}

function formatBps(v: number): string {
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(v / 1024 ** 3).toFixed(2)} GB/s`;
}

function formatBytes(v: number): string {
  if (v < 1024) return `${v.toFixed(0)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}
