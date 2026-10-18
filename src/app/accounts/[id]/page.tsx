import { AccountBudgetEditor } from "@/components/accounts/account-budget-editor";
import { AccountDefaultTagsEditor } from "@/components/accounts/account-default-tags-editor";
import { AccountHeaderActions } from "@/components/accounts/account-header-actions";
import { AccountHero } from "@/components/accounts/account-hero";
import { AccountRegionsEditor } from "@/components/accounts/account-regions-editor";
import { ProbeKeyCard } from "@/components/accounts/probe-key-card";
import { RequiredTagsEditor } from "@/components/accounts/required-tags-editor";
import { SafeTerminateEditor } from "@/components/accounts/safe-terminate-editor";
import { SnapshotRetentionEditor } from "@/components/accounts/snapshot-retention-editor";
import { VcpuQuotaEditor } from "@/components/accounts/vcpu-quota-editor";
import { ProviderName } from "@/components/cloud/provider-tile";
import { StatusBadge } from "@/components/instances/status-badge";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, EmptyState, PageHeader, PageSection, PageShell, Stat, StatGrid, Subsection } from "@/components/ui";
import { Sparkline } from "@/components/ui/sparkline";
import { decryptJSON } from "@/lib/crypto";
import { db } from "@/lib/db";
import { auditLog, cachedResources, cloudAccounts, instances } from "@/lib/db/schema";
import { priceInstances } from "@/lib/pricing";
import { formatUsd, formatUsdPerHour, HOURS_PER_MONTH } from "@/lib/utils";
import { listAccountHistory } from "@/server/queries/history";
import { desc, eq } from "drizzle-orm";
import { Activity, Boxes, KeyRound, Server, Wallet } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AccountDetailPage({ params }: PageProps) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const t = await getTranslations("cloud.accountDetail");

  const accountRows = await db.select().from(cloudAccounts).where(eq(cloudAccounts.id, id)).limit(1);
  const account = accountRows[0];
  if (!account) notFound();
  const meta = account.metadataEnc ? decryptJSON<{ accountId: string; label: string }>(account.metadataEnc) : null;
  const regions = account.regions ? safeArr(account.regions) : null;

  const [instanceRows, resourceRows, auditRows, history] = await Promise.all([
    db.select().from(instances).where(eq(instances.accountId, id)).orderBy(desc(instances.lastSyncedAt)),
    db.select().from(cachedResources).where(eq(cachedResources.accountId, id)),
    db.select().from(auditLog).where(eq(auditLog.accountId, id)).orderBy(desc(auditLog.createdAt)).limit(20),
    listAccountHistory(id),
  ]);

  const priceMap = await priceInstances(
    instanceRows.map((i) => ({
      id: i.id,
      provider: i.provider,
      region: i.region,
      instanceType: i.instanceType,
      platform: i.platform,
      accountId: i.accountId,
    })),
  );
  const running = instanceRows.filter((i) => i.state === "running");
  const hourly = running.reduce((s, i) => s + (priceMap[i.id]?.usdPerHour ?? 0), 0);

  const byRegion = new Map<string, { running: number; total: number; hourly: number }>();
  for (const i of instanceRows) {
    const slot = byRegion.get(i.region) ?? { running: 0, total: 0, hourly: 0 };
    slot.total++;
    if (i.state === "running") {
      slot.running++;
      slot.hourly += priceMap[i.id]?.usdPerHour ?? 0;
    }
    byRegion.set(i.region, slot);
  }

  const ordered = history.slice().reverse();
  const runSeries = ordered.map((r) => r.runningInstances);
  const hourlySeries = ordered.map((r) => r.hourlyUsd);

  return (
    <PageShell>
      <AccountHero accountId={account.id}>
      <PageHeader
        icon={<KeyRound />}
        title={account.name}
        badge={
          <Badge variant="info">
            <ProviderName provider={account.provider} />
          </Badge>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-xs">{meta?.label ?? meta?.accountId ?? id}</span>
            <span aria-hidden>·</span>
            <span>
              {t("connected")} <RelativeTime date={account.createdAt} />
            </span>
          </span>
        }
        breadcrumbs={
          <nav aria-label={t("breadcrumb")} className="flex items-center gap-1">
            <Link href="/accounts" className="hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              {t("allAccounts")}
            </Link>
            <span aria-hidden>/</span>
            <span aria-current="page" className="truncate text-fg" title={account.name}>
              {account.name}
            </span>
          </nav>
        }
        actions={<AccountHeaderActions accountId={account.id} name={account.name} />}
      />
      </AccountHero>

      <StatGrid cols={4}>
        <Stat icon={<Server />} label={t("stats.instances")} value={instanceRows.length} />
        <Stat icon={<Activity />} label={t("stats.running")} value={running.length} tone="success" />
        <Stat icon={<Boxes />} label={t("stats.resources")} value={resourceRows.length} />
        <Stat icon={<Wallet />} label={t("stats.burn")} value={hourly > 0 ? formatUsd(hourly * HOURS_PER_MONTH) : "—"} hint={hourly > 0 ? formatUsdPerHour(hourly) : undefined} />
      </StatGrid>

      {runSeries.length >= 2 && (
        <PageSection title={t("trend.title")} description={t("trend.description")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-2xs uppercase tracking-wider text-muted">{t("trend.running")}</div>
              <Sparkline values={runSeries} className="w-full text-success" width={400} height={60} ariaLabel={t("trend.running")} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-2xs uppercase tracking-wider text-muted">{t("trend.hourly")}</div>
              <Sparkline values={hourlySeries} className="w-full text-primary" width={400} height={60} ariaLabel={t("trend.hourly")} />
            </div>
          </div>
        </PageSection>
      )}

      <PageSection title={t("regions.title")} description={t("regions.description")}>
        <div className="space-y-4">
          <AccountRegionsEditor accountId={account.id} provider={account.provider} defaultRegion={account.defaultRegion} initialRegions={regions} />
          {byRegion.size > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from(byRegion.entries()).map(([region, s]) => (
                <div key={region} className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-surface-muted px-3 py-2 text-xs">
                  <span className="min-w-0 truncate font-mono" title={region}>{region}</span>
                  <span className="shrink-0 text-muted">
                    {t("regions.breakdown", { running: s.running, total: s.total })} ·{" "}
                    {s.hourly > 0 ? t("regions.perMonth", { amount: formatUsd(s.hourly * HOURS_PER_MONTH) }) : t("regions.free")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </PageSection>

      <PageSection title={t("probe.title")} description={t("probe.description")}>
        <ProbeKeyCard accountId={account.id} hasKey={!!account.probeKeyEnc} />
      </PageSection>

      <PageSection title={t("policies.title")} description={t("policies.description")}>
        <div className="grid gap-4 xl:grid-cols-2">
          <Subsection title={t("defaultTags.title")} hint={t("defaultTags.hint")}>
            <AccountDefaultTagsEditor accountId={account.id} initial={account.defaultTags ?? null} />
          </Subsection>
          <Subsection title={t("requiredTags.title")} hint={t("requiredTags.sectionHint")}>
            <RequiredTagsEditor accountId={account.id} initial={account.requiredTags ?? null} />
          </Subsection>
          <Subsection title={t("budget.title")} hint={t("budget.sectionHint")}>
            <AccountBudgetEditor accountId={account.id} initial={account.monthlyBudgetUsd ?? null} />
          </Subsection>
          <Subsection title={t("vcpu.title")} hint={t("vcpu.sectionHint")}>
            <VcpuQuotaEditor accountId={account.id} initial={account.vcpuQuota ?? null} />
          </Subsection>
          <Subsection title={t("retention.title")} hint={t("retention.sectionHint")}>
            <SnapshotRetentionEditor accountId={account.id} initial={account.snapshotRetentionCount ?? null} />
          </Subsection>
          <Subsection title={t("safeTerminate.title")}>
            <SafeTerminateEditor accountId={account.id} initial={account.safeTerminate ?? false} />
          </Subsection>
        </div>
      </PageSection>

      <PageSection title={t("instances.title")} description={t("instances.count", { count: instanceRows.length })}>
        {instanceRows.length === 0 ? (
          <EmptyState compact illustration="vms" icon={<Server />} title={t("instances.empty")} />
        ) : (
          <ul className="divide-y divide-border">
            {instanceRows.map((i) => {
              const u = priceMap[i.id]?.usdPerHour;
              return (
                <li key={i.id} className="flex items-center gap-3 py-2.5">
                  <Link
                    href={`/instances/${encodeURIComponent(i.id)}`}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <StatusBadge state={i.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={i.displayName ?? i.name ?? i.providerInstanceId}>{i.displayName ?? i.name ?? i.providerInstanceId}</span>
                      <span className="block truncate text-xs text-muted" title={`${i.region} · ${i.instanceType ?? "—"}`}>
                        {i.region} · {i.instanceType ?? "—"}
                      </span>
                    </span>
                  </Link>
                  <span className="shrink-0 text-right text-xs tabular-nums text-muted">
                    {typeof u !== "number" ? "—" : u === 0 ? t("regions.free") : formatUsdPerHour(u)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </PageSection>

      <PageSection title={t("activity.title")}>
        {auditRows.length === 0 ? (
          <EmptyState compact illustration="activity" icon={<Activity />} title={t("activity.empty")} />
        ) : (
          <ul className="space-y-1.5 text-xs">
            {auditRows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={r.status === "ok" ? "success" : "danger"}>{r.status}</Badge>
                <span className="font-mono">{r.action}</span>
                {r.target && <span className="min-w-0 truncate text-muted" title={r.target}>· {r.target}</span>}
                <span className="ml-auto text-muted">
                  <RelativeTime date={r.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </PageSection>
    </PageShell>
  );
}

function safeArr(raw: string): string[] | null {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v;
  } catch {
    // ignore
  }
  return null;
}
