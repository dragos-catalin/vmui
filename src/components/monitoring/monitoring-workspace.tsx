"use client";

import { AreaChartCard } from "./lazy-charts";
import { Badge, Button, DataTable, EmptyState, PageSection, type ColumnDef } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import { deployNodeExporterAction, generatePromConfigAction } from "@/server/actions/monitoring";
import { Activity, BarChart3, Download, ExternalLink, Server } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

export interface InstanceLite {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
  publicIp: string | null;
  publicDns: string | null;
  state: string;
  platform: string;
  lastCpu: number | null;
  lastMem: number | null;
}

export interface FleetSample {
  t: number;
  cpu: number | null;
  mem: number | null;
  netIn: number | null;
  netOut: number | null;
}

interface Props {
  instances: InstanceLite[];
  samples: FleetSample[];
  grafanaUrl: string;
}

async function deploy(id: string): Promise<ActionResult<{ url?: string }>> {
  const r = await deployNodeExporterAction(id);
  return r.ok ? { ok: true, data: { url: r.url } } : { ok: false, error: r.error };
}

export function MonitoringWorkspace({ instances, samples, grafanaUrl }: Props) {
  const t = useTranslations("observe.monitoring");
  const format = useFormatter();
  const [results, setResults] = React.useState<Record<string, { ok: boolean; text: string }>>({});
  const [yaml, setYaml] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const deployAction = useAction(deploy, { success: t("deployed"), refresh: false });
  const [promPending, startProm] = React.useTransition();

  const runDeploy = async (i: InstanceLite) => {
    setBusyId(i.id);
    const r = await deployAction.run(i.id);
    setBusyId(null);
    setResults((p) => ({
      ...p,
      [i.id]: r.ok ? { ok: true, text: r.data?.url ?? t("deployed") } : { ok: false, text: r.error },
    }));
  };

  const chartData = React.useMemo(
    () =>
      samples.map((s) => ({
        t: format.dateTime(new Date(s.t), { hour: "2-digit", minute: "2-digit" }),
        cpu: s.cpu,
        mem: s.mem,
        netIn: s.netIn === null ? null : s.netIn / 1024,
        netOut: s.netOut === null ? null : s.netOut / 1024,
      })),
    [samples, format],
  );

  const columns: ColumnDef<InstanceLite>[] = React.useMemo(
    () => [
      {
        id: "name",
        header: t("columns.instance"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.name ?? row.original.providerInstanceId}</div>
            <div className="truncate font-mono text-[11px] text-fg-muted">{row.original.publicIp ?? row.original.publicDns ?? "—"}</div>
          </div>
        ),
      },
      {
        id: "provider",
        header: t("columns.provider"),
        cell: ({ row }) => <Badge variant="info">{row.original.provider}</Badge>,
      },
      {
        id: "cpu",
        header: t("columns.cpu"),
        cell: ({ row }) => <span className="tabular-nums text-xs">{row.original.lastCpu === null ? "—" : `${format.number(row.original.lastCpu, { maximumFractionDigits: 0 })}%`}</span>,
      },
      {
        id: "mem",
        header: t("columns.mem"),
        cell: ({ row }) => <span className="tabular-nums text-xs">{row.original.lastMem === null ? "—" : `${format.number(row.original.lastMem, { maximumFractionDigits: 0 })}%`}</span>,
      },
      {
        id: "result",
        header: t("columns.result"),
        cell: ({ row }) => {
          const r = results[row.original.id];
          if (!r) return <span className="text-xs text-fg-muted">—</span>;
          return (
            <span className={`block max-w-[16rem] truncate text-xs ${r.ok ? "text-success" : "text-danger"}`} title={r.text}>
              {r.text}
            </span>
          );
        },
      },
    ],
    [t, format, results],
  );

  const generateProm = () =>
    startProm(async () => {
      const r = await generatePromConfigAction();
      if (r.ok) setYaml(r.yaml);
    });

  if (instances.length === 0 && samples.length === 0) {
    return (
      <EmptyState
        fill
        icon={<Server />}
        title={t("hosts.empty.title")}
        description={t("hosts.empty.description")}
        action={
          grafanaUrl ? (
            <Button variant="outline" asChild>
              <a href={grafanaUrl} target="_blank" rel="noreferrer noopener">
                {t("grafana.open")} <ExternalLink className="size-4" aria-hidden />
              </a>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {samples.length === 0 ? (
        <section aria-label={t("charts.noSamples")} className="surface p-4 sm:p-5">
          <EmptyState bare compact icon={<BarChart3 />} title={t("charts.noSamples")} description={t("charts.noSamplesHint")} />
        </section>
      ) : (
      <div className="grid gap-3 xl:grid-cols-3">
        <AreaChartCard
          title={t("charts.cpu")}
          description={t("charts.fleetAvg")}
          data={chartData}
          x="t"
          series={[{ key: "cpu", label: t("charts.cpu"), tone: "primary" }]}
          unit="%"
          yDomain={[0, 100]}
          ariaLabel={t("charts.cpuAria")}
          emptyTitle={t("charts.noSamples")}
        />
        <AreaChartCard
          title={t("charts.mem")}
          description={t("charts.fleetAvg")}
          data={chartData}
          x="t"
          series={[{ key: "mem", label: t("charts.mem"), tone: "accent" }]}
          unit="%"
          yDomain={[0, 100]}
          ariaLabel={t("charts.memAria")}
          emptyTitle={t("charts.noSamples")}
        />
        <AreaChartCard
          title={t("charts.net")}
          description={t("charts.fleetSum")}
          data={chartData}
          x="t"
          series={[
            { key: "netIn", label: t("charts.netIn"), tone: "success" },
            { key: "netOut", label: t("charts.netOut"), tone: "info" },
          ]}
          unit="KB/s"
          ariaLabel={t("charts.netAria")}
          emptyTitle={t("charts.noSamples")}
        />
      </div>
      )}

      <PageSection title={t("hosts.title")} description={t("hosts.description")}>
        {instances.length === 0 ? (
          <EmptyState bare compact icon={<Server />} title={t("hosts.empty.title")} description={t("hosts.empty.description")} />
        ) : (
        <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
          <DataTable
            columns={columns}
            data={instances}
            dense
            searchable
            getRowId={(r) => r.id}
            emptyState={<EmptyState compact bare icon={<Server />} title={t("hosts.empty.title")} description={t("hosts.empty.description")} />}
            rowActions={(i) => (
              <Button
                size="sm"
                variant="secondary"
                loading={busyId === i.id}
                disabled={busyId !== null || !(i.publicIp || i.publicDns) || i.platform === "windows"}
                onClick={() => void runDeploy(i)}
              >
                <Activity className="size-4" aria-hidden /> {t("hosts.deploy")}
              </Button>
            )}
          />
        </m.div>
        )}
      </PageSection>

      <PageSection
        title={t("prom.title")}
        description={t("prom.description")}
        action={
          yaml ? (
            <Button size="sm" variant="secondary" loading={promPending} onClick={generateProm}>
              <Download className="size-4" aria-hidden /> {t("prom.regenerate")}
            </Button>
          ) : undefined
        }
      >
        {yaml ? (
          <pre className="max-h-80 overflow-auto rounded-[var(--radius-md)] border border-border bg-bg-muted p-3 font-mono text-xs leading-relaxed">{yaml}</pre>
        ) : (
          <EmptyState
            compact
            bare
            title={t("prom.empty")}
            action={
              <Button size="sm" loading={promPending} onClick={generateProm}>
                <Download className="size-4" aria-hidden /> {t("prom.generate")}
              </Button>
            }
          />
        )}
      </PageSection>

      <PageSection
        title={t("grafana.title")}
        description={grafanaUrl ? t("grafana.description") : t("grafana.missing")}
        action={
          grafanaUrl ? (
            <Button size="sm" variant="ghost" asChild>
              <a href={grafanaUrl} target="_blank" rel="noreferrer noopener">
                {t("grafana.open")} <ExternalLink className="size-4" aria-hidden />
              </a>
            </Button>
          ) : undefined
        }
      >
        {grafanaUrl ? (
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg">
            <iframe src={grafanaUrl} className="h-[600px] w-full" title={t("grafana.title")} />
          </div>
        ) : (
          <EmptyState compact bare title={t("grafana.emptyTitle")} description={t("grafana.emptyHint")} />
        )}
      </PageSection>
    </div>
  );
}
