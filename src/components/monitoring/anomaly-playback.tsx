"use client";

import { LineChartCard } from "./lazy-charts";
import { Button, Progress, Stat, StatGrid, ToggleGroup, type ToggleOption } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useInterval } from "@/hooks/use-poll";
import { Cpu, MemoryStick, Pause, Play, RotateCcw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";

export interface PlaybackSample {
  t: number;
  cpu: number | null;
  mem: number | null;
}
interface InstanceOpt {
  id: string;
  label: string;
}

type Speed = "1" | "2" | "4" | "8";
const SPEED_MS: Record<Speed, number> = { "1": 400, "2": 200, "4": 100, "8": 50 };

export function AnomalyPlayback({ samples, instances, selected, windowHours }: { samples: PlaybackSample[]; instances: InstanceOpt[]; selected: string; windowHours: number }) {
  const t = useTranslations("observe.playback");
  const format = useFormatter();
  const router = useRouter();
  const [idx, setIdx] = React.useState(Math.max(0, samples.length - 1));
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState<Speed>("2");

  React.useEffect(() => {
    setIdx(Math.max(0, samples.length - 1));
    setPlaying(false);
  }, [samples]);

  useInterval(
    () => {
      if (idx >= samples.length - 1) setPlaying(false);
      else setIdx(idx + 1);
    },
    playing && samples.length >= 2 ? SPEED_MS[speed] : null,
  );

  const navigate = (patch: { instance?: string; window?: string }) => {
    const sp = new URLSearchParams({ instance: patch.instance ?? selected, window: patch.window ?? String(windowHours) });
    router.push(`/anomaly-playback?${sp.toString()}`);
  };

  const shown = React.useMemo(
    () =>
      samples.map((s, i) => ({
        t: format.dateTime(new Date(s.t), { hour: "2-digit", minute: "2-digit" }),
        cpu: i <= idx ? s.cpu : null,
        mem: i <= idx ? s.mem : null,
      })),
    [samples, idx, format],
  );
  const cur = samples[idx];
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${format.number(v, { maximumFractionDigits: 1 })}%`);

  const windowOptions: ToggleOption<string>[] = ["1", "6", "24", "72"].map((h) => ({ value: h, label: t("hours", { n: Number(h) }) }));
  const speedOptions: ToggleOption<Speed>[] = (Object.keys(SPEED_MS) as Speed[]).map((s) => ({ value: s, label: `${s}×` }));

  const restart = () => {
    setIdx(0);
    setPlaying(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={(v) => navigate({ instance: v })}>
          <SelectTrigger className="w-64" aria-label={t("instance")}>
            <SelectValue placeholder={t("instance")} />
          </SelectTrigger>
          <SelectContent>
            {instances.map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup value={String(windowHours)} onValueChange={(v) => navigate({ window: v })} options={windowOptions} size="sm" aria-label={t("window")} />
        <span className="text-xs text-fg-muted">{t("sampleCount", { count: samples.length })}</span>
      </div>

      <LineChartCard
        title={t("chart.title")}
        description={cur ? format.dateTime(new Date(cur.t), { dateStyle: "medium", timeStyle: "medium" }) : t("chart.description")}
        data={shown}
        x="t"
        series={[
          { key: "cpu", label: t("cpu"), tone: "primary" },
          { key: "mem", label: t("mem"), tone: "accent" },
        ]}
        unit="%"
        yDomain={[0, 100]}
        ariaLabel={t("chart.aria")}
        emptyTitle={t("empty")}
        height={260}
        action={
          <div className="flex items-center gap-1">
            <Button size="icon" variant="secondary" aria-label={playing ? t("pause") : t("play")} onClick={() => setPlaying((p) => !p)} disabled={samples.length < 2}>
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </Button>
            <Button size="icon" variant="ghost" aria-label={t("restart")} onClick={restart} disabled={samples.length < 2}>
              <RotateCcw className="size-4" aria-hidden />
            </Button>
            <ToggleGroup value={speed} onValueChange={setSpeed} options={speedOptions} size="sm" aria-label={t("speed")} />
          </div>
        }
      />

      <div className="surface p-3">
        <input
          type="range"
          min={0}
          max={Math.max(0, samples.length - 1)}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          aria-label={t("scrub")}
          aria-valuetext={cur ? format.dateTime(new Date(cur.t), { timeStyle: "medium" }) : undefined}
          disabled={samples.length < 2}
          className="w-full accent-[var(--color-primary)]"
        />
        <Progress value={samples.length > 1 ? (idx / (samples.length - 1)) * 100 : 0} size="sm" className="mt-1" />
      </div>

      <StatGrid cols={2}>
        <Stat label={t("cpu")} value={pct(cur?.cpu)} icon={<Cpu />} tone={(cur?.cpu ?? 0) > 85 ? "danger" : "default"} />
        <Stat label={t("mem")} value={pct(cur?.mem)} icon={<MemoryStick />} tone={(cur?.mem ?? 0) > 85 ? "warning" : "default"} />
      </StatGrid>
    </div>
  );
}
