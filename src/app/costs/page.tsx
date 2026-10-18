import { CostAnomaliesCard } from "@/components/costs/cost-anomalies-card";
import { CostByTagCard } from "@/components/costs/cost-by-tag-card";
import { CostForecastCard } from "@/components/costs/cost-forecast-card";
import { CostTrendCard } from "@/components/costs/cost-trend-card";
import { IdleScanSection } from "@/components/costs/idle-scan-section";
import { ProviderCostsTable, type ProviderCostRow } from "@/components/costs/provider-costs-table";
import { SavingsCandidates, type IdleCandidate, type SpotCandidate } from "@/components/costs/savings-candidates";
import { TagBudgetsCard } from "@/components/costs/tag-budgets-card";
import { TopSpendersTable, type SpenderRow } from "@/components/costs/top-spenders-table";
import { Button, EmptyState, PageHeader, PageSection, PageShell, SkeletonCard, Stat, StatGrid } from "@/components/ui";
import { ExportButtons } from "@/components/ui/export-buttons";
import { db } from "@/lib/db";
import { cloudAccounts, instances } from "@/lib/db/schema";
import { priceInstances } from "@/lib/pricing";
import { spotSavings } from "@/lib/pricing/spot";
import { formatUsd, formatUsdPerHour, HOURS_PER_MONTH } from "@/lib/utils";
import { AlertTriangle, BarChart3, Cloud, Flame, Server, Sparkles, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";
import "server-only";

export const dynamic = "force-dynamic";

interface InstanceCost {
  id: string;
  name: string | null;
  provider: string;
  region: string;
  instanceType: string | null;
  state: string;
  hourly: number | null;
  source: string | null;
  fetchedAt: Date | null;
}

export default async function CostsPage() {
  const [t, accountList, instanceList] = await Promise.all([
    getTranslations("cloud.costs"),
    db.select().from(cloudAccounts),
    db.select().from(instances),
  ]);

  const priceMap = await priceInstances(
    instanceList.map((i) => ({
      id: i.id,
      provider: i.provider,
      region: i.region,
      instanceType: i.instanceType,
      platform: i.platform,
      accountId: i.accountId,
    })),
  );

  const rows: InstanceCost[] = instanceList.map((i) => {
    const p = priceMap[i.id];
    return {
      id: i.id,
      name: i.displayName ?? i.name,
      provider: i.provider,
      region: i.region,
      instanceType: i.instanceType,
      state: i.state,
      hourly: p?.usdPerHour ?? null,
      source: p?.source ?? null,
      fetchedAt: p?.fetchedAt ?? null,
    };
  });

  // Only running VMs accrue cost.
  const running = rows.filter((r) => r.state === "running");
  const totalHourly = running.reduce((s, r) => s + (r.hourly ?? 0), 0);
  const projectedMonthly = totalHourly * HOURS_PER_MONTH;

  const byProvider = new Map<string, ProviderCostRow>();
  for (const r of rows) {
    const cur = byProvider.get(r.provider) ?? { provider: r.provider, hourly: 0, count: 0, running: 0 };
    cur.count++;
    if (r.state === "running") {
      cur.running++;
      cur.hourly += r.hourly ?? 0;
    }
    byProvider.set(r.provider, cur);
  }
  const providerRows = [...byProvider.values()].sort((a, b) => b.hourly - a.hourly);

  const topSpenders: SpenderRow[] = running
    .filter((r) => (r.hourly ?? 0) > 0)
    .sort((a, b) => (b.hourly ?? 0) - (a.hourly ?? 0))
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      region: r.region,
      instanceType: r.instanceType,
      hourly: r.hourly,
      source: r.source,
      fetchedAt: r.fetchedAt?.toISOString() ?? null,
    }));

  // Heuristic without metrics history: anything above micro/small tier that is
  // running is worth a look; the per-instance metrics tab gives the real verdict.
  const idleCandidates: IdleCandidate[] = running
    .filter((r) => (r.hourly ?? 0) >= 0.04)
    .sort((a, b) => (b.hourly ?? 0) - (a.hourly ?? 0))
    .slice(0, 6)
    .map((r) => ({ id: r.id, name: r.name, provider: r.provider, instanceType: r.instanceType, hourly: r.hourly ?? 0 }));

  const spotCandidates: SpotCandidate[] = running
    .map((r) => ({ row: r, savings: spotSavings(r.provider, r.hourly) }))
    .filter((e) => e.savings.spotEligible && e.savings.potentialMonthlySavingsUsd >= 5)
    .sort((a, b) => b.savings.potentialMonthlySavingsUsd - a.savings.potentialMonthlySavingsUsd)
    .slice(0, 8)
    .map(({ row, savings }) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      instanceType: row.instanceType,
      monthlySavingsUsd: savings.potentialMonthlySavingsUsd,
      discountFactor: savings.discountFactor,
    }));

  const accountCount = accountList.length;
  const unpriced = running.filter((r) => r.hourly === null).length;
  const hasSavings = idleCandidates.length > 0 || spotCandidates.length > 0;

  return (
    <PageShell>
      <PageHeader
        icon={<BarChart3 />}
        title={t("title")}
        description={t("description", { count: accountCount })}
        actions={
          <>
            <ExportButtons
              filename={`vmui-costs-${new Date().toISOString().slice(0, 10)}`}
              rows={rows.map((r) => ({
                id: r.id,
                provider: r.provider,
                region: r.region,
                instanceType: r.instanceType,
                name: r.name,
                state: r.state,
                hourlyUsd: r.hourly,
                monthlyUsd: r.hourly !== null ? r.hourly * HOURS_PER_MONTH : null,
              }))}
            />
            <Button asChild variant="outline" size="sm">
              <Link href="/costs/recommendations">
                <Sparkles className="size-4" aria-hidden /> {t("actions.recommendations")}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/costs/projections">
                <TrendingUp className="size-4" aria-hidden /> {t("actions.projections")}
              </Link>
            </Button>
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          fill
          icon={<Cloud />}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            <Button asChild>
              <Link href="/accounts">{t("empty.action")}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <StatGrid cols={4}>
            <Stat label={t("stats.hourlyBurn")} value={totalHourly > 0 ? formatUsdPerHour(totalHourly) : t("free")} icon={<Flame />} />
            <Stat label={t("stats.projectedMonth")} value={formatUsd(projectedMonthly)} hint={t("stats.projectedMonthHint", { hours: HOURS_PER_MONTH })} icon={<TrendingUp />} />
            <Stat label={t("stats.runningVms")} value={running.length} hint={t("stats.runningVmsHint", { total: rows.length })} icon={<Server />} />
            <Stat
              label={t("stats.unpriced")}
              value={unpriced}
              hint={t("stats.unpricedHint", { count: unpriced })}
              tone={unpriced > 0 ? "warning" : "default"}
              icon={<AlertTriangle />}
            />
          </StatGrid>

          <div className="grid gap-4 xl:grid-cols-2">
            <PageSection title={t("byProvider.title")} description={t("byProvider.description")}>
              <ProviderCostsTable rows={providerRows} totalHourly={totalHourly} />
            </PageSection>
            {topSpenders.length > 0 && (
              <PageSection title={t("topSpenders.title")} description={t("topSpenders.description")}>
                <TopSpendersTable rows={topSpenders} />
              </PageSection>
            )}
          </div>

          {hasSavings && (
            <PageSection title={t("savings.title")} description={t("savings.description")}>
              <SavingsCandidates idle={idleCandidates} spot={spotCandidates} />
            </PageSection>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <Suspense fallback={<SkeletonCard />}>
              <CostTrendCard />
            </Suspense>
            <Suspense fallback={<SkeletonCard />}>
              <CostForecastCard />
            </Suspense>
            <Suspense fallback={<SkeletonCard />}>
              <CostAnomaliesCard />
            </Suspense>
            <Suspense fallback={<SkeletonCard />}>
              <CostByTagCard />
            </Suspense>
            <TagBudgetsCard />
            <Suspense fallback={<SkeletonCard />}>
              <IdleScanSection />
            </Suspense>
          </div>
        </>
      )}
    </PageShell>
  );
}
