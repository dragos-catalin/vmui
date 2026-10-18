"use client";

import { ContainerPanel, type HostSummary } from "@/components/containers/container-panel";
import { Badge, Button, EmptyState, PageSection, Stat, StatGrid } from "@/components/ui";
import { Play, Server, Square, TerminalSquare } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useState } from "react";

export interface ContainerHost {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
  region: string;
  address: string | null;
}

export function ContainersOverview({ hosts }: { hosts: ContainerHost[] }) {
  const t = useTranslations("ops.containers");
  const [summaries, setSummaries] = useState<Record<string, HostSummary>>({});

  const onSummary = useCallback((instanceId: string, summary: HostSummary) => {
    setSummaries((prev) => {
      const cur = prev[instanceId];
      if (cur && cur.total === summary.total && cur.running === summary.running && cur.runtime === summary.runtime) return prev;
      return { ...prev, [instanceId]: summary };
    });
  }, []);

  if (hosts.length === 0) {
    return (
      <EmptyState
        icon={<Server />}
        title={t("noHosts.title")}
        description={t("noHosts.description")}
        action={
          <>
            <Button asChild>
              <Link href="/instances/new">{t("noHosts.newInstance")}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/settings">{t("noHosts.settings")}</Link>
            </Button>
          </>
        }
      />
    );
  }

  const all = Object.values(summaries);
  const running = all.reduce((n, s) => n + s.running, 0);
  const stopped = all.reduce((n, s) => n + s.stopped, 0);
  const withRuntime = all.filter((s) => s.runtime !== null).length;
  const pending = all.length < hosts.length;

  return (
    <>
      <StatGrid cols={3}>
        <Stat label={t("stats.running")} value={running} tone="success" icon={<Play />} loading={pending && all.length === 0} />
        <Stat label={t("stats.stopped")} value={stopped} tone={stopped > 0 ? "warning" : "default"} icon={<Square />} loading={pending && all.length === 0} />
        <Stat
          label={t("stats.hosts")}
          value={hosts.length}
          hint={t("stats.hostsHint", { count: withRuntime })}
          icon={<Server />}
          loading={pending && all.length === 0}
        />
      </StatGrid>

      {hosts.map((host, i) => {
        const summary = summaries[host.id];
        const name = host.name ?? host.providerInstanceId;
        return (
          <m.div
            key={host.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
          >
            <PageSection
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Server className="size-4 text-muted" aria-hidden />
                  <Link href={`/instances/${encodeURIComponent(host.id)}`} className="truncate hover:underline">
                    {name}
                  </Link>
                  <Badge variant="muted">
                    {host.provider} · {host.region}
                  </Badge>
                  {summary?.runtime && <Badge variant="info">{summary.runtime}</Badge>}
                </span>
              }
              description={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {host.address && <code className="font-mono">{host.address}</code>}
                  {summary && <span>{t("hostSummary", { running: summary.running, total: summary.total })}</span>}
                </span>
              }
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/terminal?instance=${encodeURIComponent(host.id)}`}>
                    <TerminalSquare className="size-4" aria-hidden /> {t("openTerminal")}
                  </Link>
                </Button>
              }
            >
              <ContainerPanel instanceId={host.id} onSummary={onSummary} />
            </PageSection>
          </m.div>
        );
      })}
    </>
  );
}
