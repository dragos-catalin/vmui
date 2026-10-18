import { VatraMark } from "@/components/brand/vatra-mark";
import { CostAnomalyBanner } from "@/components/dashboard/cost-anomaly-banner";
import { DashboardRail } from "@/components/dashboard/dashboard-rail";
import { HeroScene } from "@/components/dashboard/hero-scene";
import { computeSpendRows } from "@/components/dashboard/spend-rows";
import { BackgroundSync } from "@/components/instances/background-sync";
import { InstancesExplorer } from "@/components/instances/instances-explorer";
import { RunningVmsStrip } from "@/components/instances/running-vms-strip";
import { Badge, Button, EmptyState, PageSection, PageShell, SkeletonCard, SkeletonTable, Stat, StatGrid } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatUsd, HOURS_PER_MONTH } from "@/lib/utils";
import { listAccounts, listAuditLog, listInstancesWithPrices } from "@/server/queries";
import { listAccountHistory } from "@/server/queries/history";
import { ArrowRight, Layers, Play, Server, Sparkles, Square, Wallet } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("dashboard");
  return { title: t("meta.title") };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function greetingKey(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "night";
}

export default async function DashboardPage() {
  const [accounts, { instances, priceMap }, user, t] = await Promise.all([
    listAccounts(),
    listInstancesWithPrices(),
    getCurrentUser(),
    getTranslations("dashboard"),
  ]);

  if (accounts.length === 0) {
    return <Welcome />;
  }

  const runningInstances = instances.filter((i) => i.state === "running");
  const running = runningInstances.length;
  const stopped = instances.filter((i) => i.state === "stopped").length;
  const providers = Array.from(new Set(instances.map((i) => i.provider))).sort();

  const monthlyBurn = runningInstances.reduce((sum, i) => sum + (priceMap[i.id]?.usdPerHour ?? 0) * HOURS_PER_MONTH, 0);
  const knownPriceCount = runningInstances.filter((i) => priceMap[i.id]?.usdPerHour != null).length;

  const [histories, activity] = await Promise.all([
    Promise.all(accounts.map((a) => listAccountHistory(a.id, 2 * DAY_MS))),
    listAuditLog(12),
  ]);
  const yesterday = Date.now() - DAY_MS;
  let runningYesterday = 0;
  let hourlyYesterday = 0;
  let sawHistory = false;
  for (const rows of histories) {
    const snap = rows.find((r) => r.capturedAt.getTime() <= yesterday) ?? rows.at(-1);
    if (!snap) continue;
    sawHistory = true;
    runningYesterday += snap.runningInstances;
    hourlyYesterday += snap.hourlyUsd;
  }
  const runningDelta = sawHistory ? running - runningYesterday : null;
  const burnDelta = sawHistory ? Math.round(monthlyBurn - hourlyYesterday * HOURS_PER_MONTH) : null;

  const spendRows = computeSpendRows(accounts, instances, priceMap);
  const name = user?.displayName ? `, ${user.displayName}` : "";
  const hour = new Date().getHours();

  return (
    <PageShell>
      <BackgroundSync enabled />

      <section
        aria-labelledby="dashboard-title"
        className="relative overflow-hidden rounded-[var(--radius-xl)] border border-border bg-gradient-to-br from-[color-mix(in_oklch,var(--color-primary)_14%,var(--color-surface))] to-surface p-5 sm:p-7"
      >
        <HeroScene />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <Badge variant="info" className="mb-2">
              <Sparkles className="size-3" aria-hidden /> {t("hero.live")}
            </Badge>
            <h1 id="dashboard-title" className="font-display text-2xl font-semibold tracking-[-0.01em] sm:text-3xl">
              {t(`greeting.${greetingKey(hour)}`, { name })}
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted">{t("hero.summary", { accounts: accounts.length })}</p>
          </div>
          <Button asChild>
            <Link href="/instances/new">
              <Server className="size-4" aria-hidden /> {t("instances.launch")}
            </Link>
          </Button>
        </div>
      </section>

      <Suspense fallback={null}>
        <CostAnomalyBanner />
      </Suspense>

      <StatGrid cols={4}>
        <Stat
          label={t("stats.running")}
          value={running}
          tone="success"
          icon={<Play />}
          trend={runningDelta != null && runningDelta !== 0 ? { delta: runningDelta, label: t("stats.sinceYesterday") } : undefined}
        />
        <Stat label={t("stats.stopped")} value={stopped} icon={<Square />} />
        <Stat
          label={t("stats.burn")}
          value={formatUsd(monthlyBurn)}
          icon={<Wallet />}
          hint={knownPriceCount < running ? t("stats.burnEstimated", { known: knownPriceCount, total: running }) : t("stats.burnHint")}
          trend={burnDelta != null && burnDelta !== 0 ? { delta: burnDelta, label: t("stats.sinceYesterday") } : undefined}
        />
        <Stat label={t("stats.providers")} value={providers.length} icon={<Layers />} hint={t("stats.providersHint", { count: instances.length })} />
      </StatGrid>

      {runningInstances.length > 0 && (
        <Suspense fallback={<SkeletonCard />}>
          <RunningVmsStrip instances={runningInstances} priceMap={priceMap} />
        </Suspense>
      )}

      <PageSection
        title={t("instances.title")}
        description={t("instances.description", { count: instances.length, providers: providers.length })}
        action={
          <Button asChild variant="secondary" size="sm">
            <Link href="/instances/new">
              <Server className="size-4" aria-hidden /> {t("instances.launch")}
            </Link>
          </Button>
        }
      >
        {instances.length === 0 ? (
          <EmptyState
            bare
            icon={<Server />}
            title={t("instances.emptyTitle")}
            description={t("instances.emptyDescription")}
            action={
              <Button asChild>
                <Link href="/instances/new">
                  {t("instances.emptyAction")} <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            }
          />
        ) : (
          <Suspense fallback={<SkeletonTable rows={6} cols={6} />}>
            <InstancesExplorer instances={instances} providers={providers} priceMap={priceMap} />
          </Suspense>
        )}
      </PageSection>

      <DashboardRail
        spend={spendRows}
        activity={activity.map((a) => ({ id: a.id, action: a.action, target: a.target, status: a.status, message: a.message, createdAt: a.createdAt }))}
      />
    </PageShell>
  );
}

async function Welcome() {
  const t = await getTranslations("dashboard.welcome");
  const features = ["feature1", "feature2", "feature3", "feature4"] as const;
  return (
    <PageShell width="narrow" className="grid min-h-[60dvh] place-items-center">
      <section aria-labelledby="welcome-title" className="surface w-full max-w-2xl space-y-6 p-6 sm:p-10">
        <VatraMark size={48} state="intro" className="text-fg" />
        <div>
          <h1 id="welcome-title" className="text-balance font-display text-3xl font-semibold tracking-[-0.01em]">
            {t("title")}
          </h1>
          <p className="mt-2 text-pretty text-base text-fg-muted">{t("description")}</p>
        </div>
        <ul className="space-y-2 text-sm text-fg-muted">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
              {t(f)}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href="/accounts/new">
              {t("connect")} <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary" className="w-full sm:w-auto">
            <Link href="/accounts">{t("allAccounts")}</Link>
          </Button>
        </div>
      </section>
    </PageShell>
  );
}
