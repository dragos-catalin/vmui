"use client";

import { Button } from "@/components/ui/button";
import { Sparkline } from "@/components/ui/sparkline";
import { useInView } from "@/hooks/use-poll";
import { BarChart3, Cpu, MemoryStick } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useFleetStats } from "./use-fleet-stats";

/**
 * Compact, one-line stats strip for the InstanceCard. Reads the shared fleet
 * poll only while enabled, on screen and the tab is visible.
 */
export function InstanceStatsInline({
  enabled,
  onOpenDetails,
  instanceId,
}: {
  enabled: boolean;
  onOpenDetails?: () => void;
  instanceId: string;
}) {
  const t = useTranslations("vm.stats");
  const [ref, inView] = useInView<HTMLDivElement>();
  const { latest, history } = useFleetStats(instanceId, enabled && inView);

  if (!enabled) return null;
  if (!latest?.running) {
    return (
      <div ref={ref} className="flex items-center gap-2 text-2xs text-muted">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-border" aria-hidden />
        <span>{t("idle")}</span>
      </div>
    );
  }

  const cpu = Math.min(100, Math.max(0, latest.cpuPercent ?? 0));
  const memPct = Math.min(
    100,
    latest.memUsedBytes && latest.memTotalBytes
      ? (latest.memUsedBytes / latest.memTotalBytes) * 100
      : 0,
  );

  return (
    <m.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex min-w-0 items-center gap-3"
    >
      <Metric
        icon={Cpu}
        label={t("cpu")}
        value={`${cpu.toFixed(0)}%`}
        history={history.cpu}
        colorClass="text-primary"
        ariaLabel={t("trend", { metric: t("cpu") })}
      />
      <Metric
        icon={MemoryStick}
        label={t("memShort")}
        value={`${memPct.toFixed(0)}%`}
        history={history.mem}
        colorClass="text-accent"
        ariaLabel={t("trend", { metric: t("memory") })}
      />
      {onOpenDetails && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-2xs"
          onClick={onOpenDetails}
          aria-label={t("showDetails")}
          title={t("showDetails")}
        >
          <BarChart3 className="h-3 w-3" aria-hidden />
        </Button>
      )}
    </m.div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  history,
  colorClass,
  ariaLabel,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  history: number[];
  colorClass: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex min-w-12 items-center gap-1 text-2xs uppercase tracking-wider text-muted">
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </div>
      <Sparkline values={history} width={56} height={18} className={colorClass} ariaLabel={ariaLabel} />
      <div className={`w-9 text-right font-mono text-2xs tabular-nums ${colorClass}`}>{value}</div>
    </div>
  );
}
