"use client";

import { Alert, Button } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { useEventSource, usePageVisible } from "@/hooks/use-poll";
import type { ProbeMetrics } from "@/lib/probe";
import { cn } from "@/lib/utils";
import { Activity as ActivityIcon, ArrowDownUp, Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  instanceId: string;
  intervalSec?: number | null;
  initial?: ProbeMetrics | null;
}

type Tone = "ok" | "warn" | "crit";

const TONE_STROKE: Record<Tone, string> = {
  ok: "text-primary",
  warn: "text-warning",
  crit: "text-danger",
};

function formatBytes(n: number, perSec = false): string {
  const suffix = perSec ? "/s" : "";
  if (n < 1024) return `${n.toFixed(0)} B${suffix}`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}${suffix}`;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Gauge({
  label,
  value,
  unit = "%",
  max = 100,
  icon: Icon,
  tone = "ok",
}: {
  label: string;
  value: number;
  unit?: string;
  max?: number;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone?: Tone;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const r = 38;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <svg width="100" height="100" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${value.toFixed(unit === "%" ? 0 : 1)} ${unit}`}>
        <circle cx="50" cy="50" r={r} fill="none" className="stroke-[var(--color-surface-muted)]" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="currentColor"
          className={TONE_STROKE[tone]}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 50 50)"
          style={{ transition: "stroke-dasharray 300ms cubic-bezier(.4,.2,.2,1)" }}
        />
        <text x="50" y="48" textAnchor="middle" fontSize="20" fontWeight="600" className="fill-[var(--color-fg)]">
          {value.toFixed(unit === "%" ? 0 : 1)}
        </text>
        <text x="50" y="64" textAnchor="middle" fontSize="11" className="fill-[var(--color-fg-muted)]">
          {unit}
        </text>
      </svg>
      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
    </div>
  );
}

export function CockpitDashboard({ instanceId, intervalSec, initial }: Props) {
  const t = useTranslations("vm.cockpit");
  const [metrics, setMetrics] = useState<ProbeMetrics | null>(initial ?? null);
  const [history, setHistory] = useState<{ t: number; cpu: number; mem: number; netIn: number; netOut: number }[]>([]);
  const [disconnected, setDisconnected] = useState(false);
  const [running, setRunning] = useState(true);
  const interval = intervalSec ?? 10;

  const visible = usePageVisible();
  useEventSource<ProbeMetrics>(running && visible ? `/api/instances/${instanceId}/probe-stream?interval=${interval}` : null, {
    events: ["sample"],
    onMessage: (m) => {
      setMetrics(m);
      setDisconnected(false);
      setHistory((h) => [...h, { t: m.collectedAt, cpu: m.cpu, mem: m.mem, netIn: m.netIn, netOut: m.netOut }].slice(-60));
    },
    onError: () => setDisconnected(true),
  });

  const cpuTone: Tone = !metrics ? "ok" : metrics.cpu >= 90 ? "crit" : metrics.cpu >= 70 ? "warn" : "ok";
  const memTone: Tone = !metrics ? "ok" : metrics.mem >= 90 ? "crit" : metrics.mem >= 75 ? "warn" : "ok";
  const diskTone: Tone = !metrics ? "ok" : metrics.disk >= 90 ? "crit" : metrics.disk >= 80 ? "warn" : "ok";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted">
            {metrics ? t("sampleEvery", { hostname: metrics.hostname, seconds: interval }) : t("awaiting")}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRunning((r) => !r)} aria-pressed={!running}>
          {running ? t("pause") : t("resume")}
        </Button>
      </div>

      {disconnected && (
        <Alert tone="danger" className="text-xs">
          {t("disconnected")}
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Gauge label={t("cpu")} value={metrics?.cpu ?? 0} icon={Cpu} tone={cpuTone} />
        <Gauge label={t("memory")} value={metrics?.mem ?? 0} icon={MemoryStick} tone={memTone} />
        <Gauge label={t("disk")} value={metrics?.disk ?? 0} icon={HardDrive} tone={diskTone} />
        <Gauge
          label={t("load")}
          value={metrics?.load1 ?? 0}
          unit={t("loadUnit")}
          max={Math.max(4, metrics?.cores.length ?? 4)}
          icon={ActivityIcon}
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-4 text-xs">
            <ArrowDownUp className="mb-1 h-4 w-4 text-primary" aria-hidden />
            <div className="font-mono text-sm">{formatBytes(metrics?.netIn ?? 0, true)}</div>
            <div className="font-mono text-[10px] text-muted">{t("in")}</div>
            <div className="mt-1 font-mono text-sm">{formatBytes(metrics?.netOut ?? 0, true)}</div>
            <div className="font-mono text-[10px] text-muted">{t("out")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-4 text-xs">
            <Clock className="mb-1 h-4 w-4 text-primary" aria-hidden />
            <div className="text-sm font-semibold">{metrics ? formatUptime(metrics.uptimeSec) : "—"}</div>
            <div className="text-[10px] text-muted">{t("uptime")}</div>
            <div className="mt-1 text-[10px] text-muted">
              {t("iops", { read: metrics?.iopsRead ?? "—", write: metrics?.iopsWrite ?? "—" })}
            </div>
          </CardContent>
        </Card>
      </div>

      {metrics && metrics.cores.length > 0 && (
        <Card>
          <CardContent className="py-3">
            <div className="mb-2 text-xs font-semibold text-muted">{t("perCore", { count: metrics.cores.length })}</div>
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(metrics.cores.length, 16)}, minmax(0, 1fr))` }}>
              {metrics.cores.map((c, i) => (
                <div
                  key={i}
                  className="relative h-12 overflow-hidden rounded-[var(--radius-sm)] bg-surface-muted"
                  title={t("coreTitle", { index: i, percent: c.toFixed(1) })}
                >
                  <div
                    className={cn(
                      "absolute inset-x-0 bottom-0 transition-[height] duration-300",
                      c >= 80 ? "bg-danger" : c >= 50 ? "bg-warning" : "bg-primary",
                    )}
                    style={{ height: `${Math.min(100, c)}%` }}
                  />
                  <div className="absolute inset-x-0 bottom-0 text-center text-[8px] font-mono leading-3 text-fg mix-blend-difference">
                    {Math.round(c)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {history.length > 1 && (
        <Card>
          <CardContent className="py-3">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted">
              <span>{t("lastSamples", { count: history.length })}</span>
              <span className="font-mono text-[10px]">
                {formatBytes(metrics?.memUsedMb ? metrics.memUsedMb * 1024 * 1024 : 0)} /{" "}
                {formatBytes(metrics?.memTotalMb ? metrics.memTotalMb * 1024 * 1024 : 0)}
              </span>
            </div>
            <div className="mb-2">
              <div className="mb-0.5 text-[10px] text-muted">{t("cpuPct")}</div>
              <Sparkline values={history.map((h) => h.cpu)} width={600} height={32} className="w-full text-primary" ariaLabel={t("cpuPct")} />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] text-muted">{t("memPct")}</div>
              <Sparkline values={history.map((h) => h.mem)} width={600} height={32} className="w-full text-accent" ariaLabel={t("memPct")} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
