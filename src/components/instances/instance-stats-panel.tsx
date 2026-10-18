"use client";

import { Alert, PageSection } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/ui/sparkline";
import { cn } from "@/lib/utils";
import {
    ArrowDown,
    ArrowUp,
    Clock,
    Cpu,
    HardDrive,
    MemoryStick,
    Network,
    WifiOff,
} from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import {
    formatBps,
    formatBytes,
    formatUptime,
    useInstanceStats,
} from "./use-instance-stats";

interface Props {
  accountId: string;
  enabled?: boolean;
  intervalMs?: number;
  className?: string;
  providerInstanceId?: string;
  instanceId?: string;
}

type IconType = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * Detailed live stats panel — CPU, memory, disk I/O, network — with sparklines
 * over the last ~60 samples. Updates every 2 s by default.
 */
export function InstanceStatsPanel({
  accountId,
  enabled = true,
  intervalMs = 2000,
  className,
  providerInstanceId,
  instanceId,
}: Props) {
  const t = useTranslations("vm.stats");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { latest, history, error } = useInstanceStats(accountId, { enabled, intervalMs, providerInstanceId, instanceId });

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={<LiveBadge running={latest?.running ?? false} />}
      className={className}
    >
      <div className="space-y-4">
        {error && (
          <Alert tone="danger" className="text-xs">
            {error === "common.error" ? tc("error") : error}
          </Alert>
        )}

        {latest?.note && <p className="text-xs text-muted">{latest.note}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Tile
            icon={Cpu}
            label={t("cpu")}
            primary={
              latest?.cpuPercent !== undefined
                ? `${latest.cpuPercent.toFixed(1)}%`
                : "—"
            }
            secondary={t("cpuHint")}
            history={history.cpu}
            colorClass="text-primary"
            ariaLabel={t("trend", { metric: t("cpu") })}
          />
          <Tile
            icon={MemoryStick}
            label={t("memory")}
            primary={
              latest?.memUsedBytes && latest.memTotalBytes
                ? `${Math.min(100, (latest.memUsedBytes / latest.memTotalBytes) * 100).toFixed(0)}%`
                : "—"
            }
            secondary={
              latest?.memUsedBytes
                ? `${formatBytes(latest.memUsedBytes)} / ${formatBytes(latest.memTotalBytes)}`
                : t("memoryFallback")
            }
            history={history.mem}
            colorClass="text-accent"
            ariaLabel={t("trend", { metric: t("memory") })}
          />
          <DualTile
            icon={HardDrive}
            label={t("diskIo")}
            seriesA={{ name: t("read"), values: history.diskR, colorClass: "text-info" }}
            seriesB={{ name: t("write"), values: history.diskW, colorClass: "text-warning" }}
            primaryA={formatBps(latest?.diskReadBps)}
            primaryB={formatBps(latest?.diskWriteBps)}
            iconA={ArrowDown}
            iconB={ArrowUp}
            trendLabel={(name) => t("trend", { metric: name })}
          />
          <DualTile
            icon={Network}
            label={t("network")}
            seriesA={{ name: t("rx"), values: history.netRx, colorClass: "text-success" }}
            seriesB={{ name: t("tx"), values: history.netTx, colorClass: "text-primary" }}
            primaryA={formatBps(latest?.netRxBps)}
            primaryB={formatBps(latest?.netTxBps)}
            iconA={ArrowDown}
            iconB={ArrowUp}
            trendLabel={(name) => t("trend", { metric: name })}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" aria-hidden />
            {t("uptime")}: <span className="font-mono">{formatUptime(latest?.uptimeSeconds)}</span>
          </div>
          <div>
            {t("sampled", {
              time: latest?.sampledAt ? format.dateTime(new Date(latest.sampledAt), { timeStyle: "medium" }) : "—",
            })}
          </div>
        </div>
      </div>
    </PageSection>
  );
}

function LiveBadge({ running }: { running: boolean }) {
  const t = useTranslations("vm.stats");
  return (
    <Badge variant={running ? "success" : "muted"} className="gap-1.5">
      {running ? (
        <>
          <m.span
            className="inline-block h-1.5 w-1.5 rounded-full bg-current"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            aria-hidden
          />
          {t("live")}
        </>
      ) : (
        <>
          <WifiOff className="h-3 w-3" aria-hidden />
          {t("offline")}
        </>
      )}
    </Badge>
  );
}

function Tile({
  icon: Icon,
  label,
  primary,
  secondary,
  history,
  colorClass,
  ariaLabel,
}: {
  icon: IconType;
  label: string;
  primary: string;
  secondary: string;
  history: number[];
  colorClass: string;
  ariaLabel: string;
}) {
  return (
    <m.div layout className="rounded-[var(--radius-md)] border border-border bg-bg-muted p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </div>
        <div className={cn("font-mono text-base tabular-nums", colorClass)}>{primary}</div>
      </div>
      <div className="mt-1 text-[11px] text-muted">{secondary}</div>
      <div className="mt-2">
        <Sparkline values={history} width={260} height={42} className={cn("w-full", colorClass)} ariaLabel={ariaLabel} />
      </div>
    </m.div>
  );
}

function DualTile({
  icon: Icon,
  label,
  seriesA,
  seriesB,
  primaryA,
  primaryB,
  iconA: IconA,
  iconB: IconB,
  trendLabel,
}: {
  icon: IconType;
  label: string;
  seriesA: { name: string; values: number[]; colorClass: string };
  seriesB: { name: string; values: number[]; colorClass: string };
  primaryA: string;
  primaryB: string;
  iconA: IconType;
  iconB: IconType;
  trendLabel: (name: string) => string;
}) {
  return (
    <m.div layout className="rounded-[var(--radius-md)] border border-border bg-bg-muted p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums">
          <span className={cn("flex items-center gap-1", seriesA.colorClass)} title={seriesA.name}>
            <IconA className="h-3 w-3" aria-hidden />
            {primaryA}
          </span>
          <span className={cn("flex items-center gap-1", seriesB.colorClass)} title={seriesB.name}>
            <IconB className="h-3 w-3" aria-hidden />
            {primaryB}
          </span>
        </div>
      </div>
      <div className="relative mt-2 h-[42px]">
        <div className="absolute inset-0">
          <Sparkline
            values={seriesA.values}
            width={260}
            height={42}
            className={cn("w-full", seriesA.colorClass)}
            ariaLabel={trendLabel(seriesA.name)}
          />
        </div>
        <div className="absolute inset-0">
          <Sparkline
            values={seriesB.values}
            width={260}
            height={42}
            className={cn("w-full", seriesB.colorClass)}
            ariaLabel={trendLabel(seriesB.name)}
          />
        </div>
      </div>
    </m.div>
  );
}
