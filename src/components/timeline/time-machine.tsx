"use client";

import { LineChartCard } from "@/components/monitoring/lazy-charts";
import { Badge, EmptyState, Stat, StatGrid, ToggleGroup, type ToggleOption } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listTimelineInstancesAction, loadTimelineAction } from "@/server/actions/timeline";
import { ArrowDown, ArrowUp, Clock, Cpu, MemoryStick, Server } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

interface Sample {
  t: number;
  cpu: number | null;
  mem: number | null;
  netIn: number | null;
  netOut: number | null;
  load1: number | null;
}
interface Audit {
  t: number;
  action: string;
  status: string;
  message: string | null;
}
interface Inst {
  id: string;
  name: string | null;
  provider: string;
  region: string;
}

type Range = "1h" | "6h" | "24h" | "7d";
const RANGE_MS: Record<Range, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };

export function TimeMachine() {
  const t = useTranslations("observe.timeline");
  const format = useFormatter();
  const [insts, setInsts] = React.useState<Inst[]>([]);
  const [selected, setSelected] = React.useState("");
  const [range, setRange] = React.useState<Range>("24h");
  const [samples, setSamples] = React.useState<Sample[]>([]);
  const [audits, setAudits] = React.useState<Audit[]>([]);
  const [scrubT, setScrubT] = React.useState(0);
  const [pending, start] = React.useTransition();

  React.useEffect(() => {
    void listTimelineInstancesAction().then((r) => {
      setInsts(r);
      if (r[0]) setSelected(r[0].id);
    });
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    const toMs = Date.now();
    start(async () => {
      const r = await loadTimelineAction({ instanceId: selected, fromMs: toMs - RANGE_MS[range], toMs });
      if (r.ok) {
        setSamples(r.samples);
        setAudits(r.audits);
        setScrubT(toMs);
      }
    });
  }, [selected, range]);

  const minT = samples[0]?.t ?? Date.now() - RANGE_MS[range];
  const maxT = samples.at(-1)?.t ?? Date.now();

  const nearest = React.useMemo(() => {
    if (samples.length === 0) return null;
    let best = samples[0]!;
    for (const s of samples) if (Math.abs(s.t - scrubT) < Math.abs(best.t - scrubT)) best = s;
    return best;
  }, [samples, scrubT]);

  const nearby = React.useMemo(() => audits.filter((a) => Math.abs(a.t - scrubT) < RANGE_MS[range] / 20).slice(0, 10), [audits, scrubT, range]);

  const chartData = React.useMemo(
    () => samples.map((s) => ({ t: format.dateTime(new Date(s.t), range === "7d" ? { month: "short", day: "2-digit", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" }), cpu: s.cpu, mem: s.mem })),
    [samples, format, range],
  );

  const rangeOptions: ToggleOption<Range>[] = (Object.keys(RANGE_MS) as Range[]).map((r) => ({ value: r, label: t(`range.${r}`) }));

  const fmtBytes = (v: number | null | undefined) => {
    if (v === null || v === undefined) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let n = v;
    let i = 0;
    while (n > 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${format.number(n, { maximumFractionDigits: 1 })} ${units[i]}`;
  };
  const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${format.number(v, { maximumFractionDigits: 1 })}%`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-64" aria-label={t("instance")}>
            <SelectValue placeholder={t("instance")} />
          </SelectTrigger>
          <SelectContent>
            {insts.map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name ?? i.id} · {i.provider} · {i.region}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup value={range} onValueChange={setRange} options={rangeOptions} size="sm" aria-label={t("rangeLabel")} />
        {pending && <Badge variant="muted">{t("loading")}</Badge>}
      </div>

      <LineChartCard
        title={t("chart.title")}
        description={t("chart.description")}
        data={chartData}
        x="t"
        series={[
          { key: "cpu", label: t("metrics.cpu"), tone: "primary" },
          { key: "mem", label: t("metrics.mem"), tone: "accent" },
        ]}
        unit="%"
        yDomain={[0, 100]}
        ariaLabel={t("chart.aria")}
        loading={pending && samples.length === 0}
        emptyTitle={t("chart.empty")}
        height={200}
      />

      <div className="surface flex items-center gap-3 p-3">
        <Clock className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <input
          type="range"
          min={minT}
          max={maxT}
          value={Math.min(maxT, Math.max(minT, scrubT))}
          onChange={(e) => setScrubT(Number(e.target.value))}
          aria-label={t("scrub")}
          aria-valuetext={format.dateTime(new Date(scrubT), { dateStyle: "medium", timeStyle: "short" })}
          disabled={samples.length < 2}
          className="min-w-0 flex-1 accent-[var(--color-primary)]"
        />
        <time dateTime={new Date(scrubT).toISOString()} className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">
          {format.dateTime(new Date(scrubT), { dateStyle: "short", timeStyle: "short" })}
        </time>
      </div>

      <StatGrid cols={4}>
        <Stat label={t("metrics.cpu")} value={fmtPct(nearest?.cpu)} icon={<Cpu />} />
        <Stat label={t("metrics.mem")} value={fmtPct(nearest?.mem)} icon={<MemoryStick />} />
        <Stat label={t("metrics.netIn")} value={fmtBytes(nearest?.netIn)} icon={<ArrowDown />} />
        <Stat label={t("metrics.netOut")} value={fmtBytes(nearest?.netOut)} icon={<ArrowUp />} />
      </StatGrid>

      <section aria-labelledby="tm-events" className="surface p-4">
        <h2 id="tm-events" className="mb-3 text-sm font-semibold">
          {t("events.title")}
        </h2>
        {nearby.length === 0 ? (
          <EmptyState illustration="activity" compact icon={<Server />} title={t("events.empty")} />
        ) : (
          <ol className="relative space-y-3 pl-6 before:absolute before:bottom-1 before:left-[7px] before:top-1 before:w-px before:bg-border">
            {nearby.map((a, i) => {
              const ok = a.status === "ok";
              return (
                <m.li
                  key={`${a.t}-${i}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                  className="relative"
                >
                  <span className={`absolute -left-6 top-1.5 size-[15px] rounded-full ring-4 ring-surface ${ok ? "bg-success" : "bg-danger"}`} aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{a.action}</span>
                    <Badge variant={ok ? "success" : "danger"}>{a.status}</Badge>
                    <time dateTime={new Date(a.t).toISOString()} className="ml-auto text-xs tabular-nums text-fg-muted">
                      {format.dateTime(new Date(a.t), { timeStyle: "medium" })}
                    </time>
                  </div>
                  {a.message && <p className="mt-0.5 truncate text-xs text-fg-muted">{a.message}</p>}
                </m.li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
