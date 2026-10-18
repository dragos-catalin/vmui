import { ContainerPanel } from "@/components/containers/container-panel";
import { AutoStartToggle } from "@/components/instances/auto-start-toggle";
import { CloudInitStream } from "@/components/instances/cloud-init-stream";
import { CockpitDashboard } from "@/components/instances/cockpit-dashboard";
import { CodaiEnvironmentCard } from "@/components/instances/codai-environment-card";
import { ConsoleLinkButton } from "@/components/instances/console-link-button";
import { ConsoleLogsCard } from "@/components/instances/console-logs-card";
import { InstanceActions } from "@/components/instances/instance-actions";
import { InstanceHero } from "@/components/instances/instance-hero";
import { instanceLabel } from "@/components/instances/instance-label";
import { InstanceSnapshotsCard } from "@/components/instances/instance-snapshots-card";
import { parseInstanceSpecs } from "@/components/instances/instance-specs";
import { InstanceStatsPanel } from "@/components/instances/instance-stats-panel";
import { InstanceTabs } from "@/components/instances/instance-tabs";
import { MetricsTab } from "@/components/instances/metrics-tab";
import { RelatedResourcesCard } from "@/components/instances/related-resources-card";
import { RunbookEditor } from "@/components/instances/runbook-editor";
import { SecretsVault } from "@/components/instances/secrets-vault";
import { ShowAsCodeDialog } from "@/components/instances/show-as-code-dialog";
import { StatusBadge } from "@/components/instances/status-badge";
import { StickyNotesCard } from "@/components/instances/sticky-notes";
import { TerminationLockButton } from "@/components/instances/termination-lock-button";
import { VmHardwareConfig } from "@/components/instances/vm-hardware-config";
import { VmScreenshot } from "@/components/instances/vm-screenshot";
import { InstanceSchedulesCard } from "@/components/schedules/instance-schedules-card";
import { Button, PageHeader, PageSection, PageShell, SkeletonCard, Stat, StatGrid } from "@/components/ui";
import { getInstancePrice } from "@/lib/pricing";
import { getCodaiLink } from "@/lib/codai/links";
import { getCodaiSettingsPublic } from "@/lib/codai/settings";
import type { ProviderId } from "@/lib/providers/types";
import { formatUsd, formatUsdPerHour, HOURS_PER_MONTH } from "@/lib/utils";
import { getInstanceById } from "@/server/queries";
import { listSchedulesForInstance } from "@/server/queries/schedules";
import { Apple, Cpu, HardDrive, MemoryStick, MonitorSmartphone, Server, SquareTerminal, Wallet } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

const CLOUD = new Set<string>(["aws", "azure", "gcp"]);
const UNIXY = new Set<string>(["linux", "macos"]);

export default async function InstanceDetailPage({ params }: PageProps) {
  const { id } = await params;
  const instance = await getInstanceById(decodeURIComponent(id));
  if (!instance) notFound();

  const [price, schedules, t, tPlatform, format, codaiLink, codaiSettings] = await Promise.all([
    getInstancePrice(instance.provider, instance.region, instance.instanceType, instance.platform, instance.accountId),
    listSchedulesForInstance(instance.id),
    getTranslations("vm.detail"),
    getTranslations("vm.platform"),
    getFormatter(),
    getCodaiLink(instance.id),
    getCodaiSettingsPublic(),
  ]);

  const Icon = instance.platform === "macos" ? Apple : instance.platform === "windows" ? MonitorSmartphone : Server;
  const label = instanceLabel(instance);
  const isKvm = instance.provider === "local-kvm";
  const isCloud = CLOUD.has(instance.provider);
  const running = instance.state === "running";
  const unixy = UNIXY.has(instance.platform);
  const specs = parseInstanceSpecs(instance);
  const href = `/instances/${encodeURIComponent(instance.id)}`;
  const platformLabel = (["linux", "windows", "macos"] as const).includes(instance.platform as "linux") ? tPlatform(instance.platform as "linux" | "windows" | "macos") : instance.platform;
  const now = new Date();
  const rel = (d: Date | null) => (d ? format.relativeTime(d, now) : t("overview.empty"));

  const rows: { key: string; value: React.ReactNode; mono?: boolean }[] = [
    { key: "instanceType", value: instance.instanceType ?? t("overview.empty"), mono: true },
    { key: "platform", value: platformLabel },
    { key: "provider", value: instance.provider },
    { key: "region", value: instance.region },
    { key: "instanceId", value: instance.providerInstanceId, mono: true },
    { key: "publicIp", value: instance.publicIp ?? t("overview.empty"), mono: true },
    { key: "privateIp", value: instance.privateIp ?? t("overview.empty"), mono: true },
    { key: "publicDns", value: instance.publicDns ?? t("overview.empty"), mono: true },
    { key: "keyName", value: instance.keyName ?? t("overview.empty"), mono: true },
    { key: "created", value: rel(instance.createdAt) },
    { key: "lastStateChange", value: rel(instance.lastStateChangeAt) },
    { key: "lastSynced", value: rel(instance.lastSyncedAt) },
  ];
  if (price && price.usdPerHour != null) {
    rows.push({
      key: "price",
      value: price.usdPerHour === 0 ? t("stats.free") : t("overview.priceValue", { hourly: formatUsdPerHour(price.usdPerHour), monthly: formatUsd(price.usdPerHour * HOURS_PER_MONTH) }),
    });
  }

  const overview = (
    <>
      <PageSection title={t("overview.title")} description={t("overview.description")}>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr] xl:grid-cols-[minmax(8rem,auto)_1fr_minmax(8rem,auto)_1fr]">
          {rows.map((r) => (
            <div key={r.key} className="contents">
              <dt className="text-xs uppercase tracking-wider text-muted sm:pt-0.5">{t(`overview.${r.key}` as "overview.region")}</dt>
              <dd className={r.mono ? "min-w-0 break-all font-mono text-xs" : "min-w-0 truncate"}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </PageSection>

      {isKvm && (
        <PageSection title={t("preview.title")} description={t("preview.description")}>
          <VmScreenshot accountId={instance.accountId} enabled={running} maxWidth={960} intervalMs={5000} />
        </PageSection>
      )}

      {isKvm && (
        <PageSection
          title={t("localKvm.title")}
          description={t("localKvm.description")}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href={`${href}/console`}>
                <SquareTerminal className="size-4" aria-hidden /> {t("localKvm.openConsole")}
              </Link>
            </Button>
          }
        >
          <AutoStartToggle accountId={instance.accountId} />
        </PageSection>
      )}

      {unixy && <CloudInitStream instanceId={instance.id} platform={instance.platform} />}

      {instance.rawJson && (
        <PageSection title={t("raw.title")} description={t("raw.description")}>
          <pre className="max-h-96 overflow-auto rounded-[var(--radius-md)] bg-bg-muted p-3 text-xs leading-relaxed">{JSON.stringify(JSON.parse(instance.rawJson), null, 2)}</pre>
        </PageSection>
      )}
    </>
  );

  const showStats = (isKvm || instance.provider === "aws") && running;
  const showCockpit = running && unixy;
  const monitoring =
    showStats || showCockpit || isCloud ? (
      <>
        {showStats && (
          <Suspense fallback={<SkeletonCard />}>
            <InstanceStatsPanel accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} instanceId={instance.id} />
          </Suspense>
        )}
        {showCockpit && (
          <PageSection title={t("cockpit.title")} description={t("cockpit.description")}>
            <CockpitDashboard instanceId={instance.id} intervalSec={instance.probeIntervalSec ?? undefined} />
          </PageSection>
        )}
        {showCockpit && (
          <PageSection title={t("containers.title")} description={t("containers.description")}>
            <ContainerPanel instanceId={instance.id} />
          </PageSection>
        )}
        {isCloud && <MetricsTab accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} enabled={running} />}
        {isCloud && <ConsoleLogsCard accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} />}
      </>
    ) : null;

  const operations = (
    <>
      {isCloud && (
        <div id="snapshots" className="scroll-mt-4">
          <Suspense fallback={<SkeletonCard />}>
            <InstanceSnapshotsCard accountId={instance.accountId} region={instance.region} providerInstanceId={instance.providerInstanceId} provider={instance.provider} />
          </Suspense>
        </div>
      )}
      {isCloud && (
        <Suspense fallback={<SkeletonCard />}>
          <RelatedResourcesCard accountId={instance.accountId} region={instance.region} providerInstanceId={instance.providerInstanceId} />
        </Suspense>
      )}
      {isKvm && <VmHardwareConfig accountId={instance.accountId} vmRunning={running} />}
      <CodaiEnvironmentCard
        instanceId={instance.id}
        instanceName={label}
        platform={instance.platform}
        codaiConfigured={codaiSettings.configured}
        initialLink={
          codaiLink
            ? { environmentId: codaiLink.environmentId, projectId: codaiLink.projectId, slug: codaiLink.slug, state: codaiLink.lastStatus, lastCheckedAt: codaiLink.lastCheckedAt }
            : null
        }
      />
      <div id="schedules" className="scroll-mt-4">
        <InstanceSchedulesCard
          instanceId={instance.id}
          schedules={schedules.map((s) => ({
            id: s.id,
            cron: s.cron,
            action: s.action,
            enabled: s.enabled,
            label: s.label,
            lastRunAt: s.lastRunAt,
            lastRunStatus: s.lastRunStatus,
          }))}
        />
      </div>
    </>
  );

  const notes = (
    <>
      <Suspense fallback={<SkeletonCard />}>
        <StickyNotesCard accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} />
      </Suspense>
      <Suspense fallback={<SkeletonCard />}>
        <RunbookEditor accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} />
      </Suspense>
      <Suspense fallback={<SkeletonCard />}>
        <SecretsVault accountId={instance.accountId} providerInstanceId={instance.providerInstanceId} />
      </Suspense>
    </>
  );

  return (
    <PageShell>
      <InstanceHero instanceId={instance.id}>
        <PageHeader
          title={label}
          icon={<Icon />}
          badge={<StatusBadge state={instance.state} />}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs">{instance.providerInstanceId}</span>
              <span aria-hidden>·</span>
              <span>{instance.region}</span>
              <span aria-hidden>·</span>
              <span>{instance.provider}</span>
            </span>
          }
          breadcrumbs={
            <nav aria-label={t("breadcrumbInstances")} className="flex items-center gap-1">
              <Link href="/" className="hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {t("back")}
              </Link>
              <span aria-hidden>/</span>
              <span aria-current="page" className="truncate text-fg" title={label}>
                {label}
              </span>
            </nav>
          }
          actions={
            <div className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto">
              <InstanceActions instance={instance} />
              <Suspense fallback={null}>
                <ConsoleLinkButton providerId={instance.provider as ProviderId} region={instance.region} providerInstanceId={instance.providerInstanceId} />
              </Suspense>
              <ShowAsCodeDialog
                instance={{
                  provider: instance.provider as "aws" | "azure" | "gcp" | "scaleway" | "digitalocean" | "hetzner" | "local-kvm",
                  region: instance.region,
                  providerInstanceId: instance.providerInstanceId,
                  name: instance.name,
                  instanceType: instance.instanceType,
                  platform: instance.platform as "linux" | "windows" | "macos",
                }}
              />
              <TerminationLockButton accountId={instance.accountId} region={instance.region} providerInstanceId={instance.providerInstanceId} initial={instance.terminationLocked ?? false} />
              {unixy && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`${href}/ssh`}>
                    <SquareTerminal className="size-4" aria-hidden /> {t("localKvm.openSsh")}
                  </Link>
                </Button>
              )}
            </div>
          }
        />
      </InstanceHero>

      <StatGrid cols={4}>
        <Stat label={t("stats.vcpu")} value={specs.vcpu ?? t("stats.unknown")} icon={<Cpu />} hint={specs.vcpu == null ? t("stats.notReported") : undefined} />
        <Stat label={t("stats.ram")} value={specs.ramGb != null ? t("stats.ramValue", { gb: specs.ramGb }) : t("stats.unknown")} icon={<MemoryStick />} hint={specs.ramGb == null ? t("stats.notReported") : undefined} />
        <Stat label={t("stats.disks")} value={specs.disks ?? t("stats.unknown")} icon={<HardDrive />} hint={specs.disks == null ? t("stats.notReported") : undefined} />
        <Stat
          label={t("stats.monthly")}
          value={price?.usdPerHour == null ? t("stats.unknown") : price.usdPerHour === 0 ? t("stats.free") : formatUsd(price.usdPerHour * HOURS_PER_MONTH)}
          tone={price?.usdPerHour === 0 ? "success" : "default"}
          icon={<Wallet />}
          hint={price?.usdPerHour ? t("stats.hourly", { price: formatUsdPerHour(price.usdPerHour) }) : undefined}
        />
      </StatGrid>

      <InstanceTabs panels={{ overview, monitoring, operations, notes }} />
    </PageShell>
  );
}
