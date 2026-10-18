"use client";

import { ProviderName, ProviderTile } from "@/components/cloud/provider-tile";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, DataTable, EmptyState, ToggleGroup, type ColumnDef } from "@/components/ui";
import { Sparkline } from "@/components/ui/sparkline";
import { formatUsd, HOURS_PER_MONTH } from "@/lib/utils";
import { ArrowRight, KeyRound, LayoutGrid, List } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState, ViewTransition } from "react";
import { accountMorphName } from "./account-hero";
import { DeleteAccountButton } from "./delete-account-button";

export type AccountHealthTone = "ok" | "warn" | "bad";

export interface AccountCardData {
  id: string;
  name: string;
  provider: string;
  meta: string | null;
  regions: string[];
  health: AccountHealthTone | null;
  healthReasons: string[];
  lastSyncAt: string | null;
  hourlyUsd: number | null;
  runningSeries: number[];
}

type ViewMode = "grid" | "list";
const STORAGE_KEY = "vmui.accounts.view";
const HEALTH_VARIANT: Record<AccountHealthTone, "success" | "warning" | "danger"> = { ok: "success", warn: "warning", bad: "danger" };

export function AccountsView({ accounts }: { accounts: AccountCardData[] }) {
  const t = useTranslations("cloud.accounts");
  const [view, setView] = useState<ViewMode>("grid");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "grid" || saved === "list") setView(saved);
  }, []);

  const changeView = (v: ViewMode) => {
    setView(v);
    window.localStorage.setItem(STORAGE_KEY, v);
  };

  if (accounts.length === 0) {
    return (
      <EmptyState
        fill
        icon={<KeyRound />}
        title={t("empty.title")}
        description={t("empty.description")}
        action={
          <Button asChild>
            <Link href="/accounts/new">{t("empty.action")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ToggleGroup
          value={view}
          onValueChange={changeView}
          aria-label={t("viewLabel")}
          size="sm"
          options={[
            { value: "grid", label: <span className="sr-only sm:not-sr-only">{t("view.grid")}</span>, icon: <LayoutGrid aria-hidden /> },
            { value: "list", label: <span className="sr-only sm:not-sr-only">{t("view.list")}</span>, icon: <List aria-hidden /> },
          ]}
        />
      </div>
      {view === "grid" ? <AccountsGrid accounts={accounts} /> : <AccountsTable accounts={accounts} />}
    </div>
  );
}

function HealthBadge({ health, reasons }: { health: AccountHealthTone | null; reasons: string[] }) {
  const t = useTranslations("cloud.accounts.health");
  if (!health) return null;
  return (
    <Badge variant={HEALTH_VARIANT[health]} title={reasons.join(" · ") || undefined}>
      {t(health)}
    </Badge>
  );
}

function RegionChips({ regions, max = 4 }: { regions: string[]; max?: number }) {
  const t = useTranslations("cloud.accounts");
  if (regions.length === 0) return <span className="text-xs text-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {regions.slice(0, max).map((r) => (
        <Badge key={r} variant="muted">
          {r}
        </Badge>
      ))}
      {regions.length > max && <Badge variant="muted">{t("moreRegions", { count: regions.length - max })}</Badge>}
    </span>
  );
}

function Spend({ hourlyUsd }: { hourlyUsd: number | null }) {
  const t = useTranslations("cloud.accounts");
  if (hourlyUsd == null) return <span className="text-muted">—</span>;
  if (hourlyUsd === 0) return <span className="text-success">{t("free")}</span>;
  return <span className="tabular-nums">{t("perMonth", { amount: formatUsd(hourlyUsd * HOURS_PER_MONTH) })}</span>;
}

function AccountsGrid({ accounts }: { accounts: AccountCardData[] }) {
  const t = useTranslations("cloud.accounts");
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
      {accounts.map((a, i) => (
        <ViewTransition key={a.id} name={accountMorphName(a.id)}>
        <m.div
          layoutId={accountMorphName(a.id)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.035 }}
          className="surface card-hover flex min-w-0 flex-col gap-3 p-4"
        >
          <div className="flex items-start gap-3">
            <ProviderTile provider={a.provider} size="lg" />
            <div className="min-w-0 flex-1">
              <Link
                href={`/accounts/${encodeURIComponent(a.id)}`}
                className="block truncate font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                title={a.name}
              >
                {a.name}
              </Link>
              <p className="truncate font-mono text-xs text-muted" title={a.meta ?? undefined}>{a.meta ?? <ProviderName provider={a.provider} />}</p>
            </div>
            <HealthBadge health={a.health} reasons={a.healthReasons} />
          </div>

          <RegionChips regions={a.regions} />

          <dl className="mt-auto grid grid-cols-2 gap-2 text-xs">
            <div className="min-w-0">
              <dt className="text-muted">{t("lastSync")}</dt>
              <dd className="truncate">{a.lastSyncAt ? <RelativeTime date={a.lastSyncAt} /> : t("never")}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted">{t("monthlySpend")}</dt>
              <dd className="truncate">
                <Spend hourlyUsd={a.hourlyUsd} />
              </dd>
            </div>
          </dl>

          {a.runningSeries.length >= 2 && (
            <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-surface-muted px-3 py-2">
              <span className="text-2xs text-muted">{t("trend")}</span>
              <Sparkline values={a.runningSeries} ariaLabel={t("trendAria", { name: a.name })} className="text-success" />
            </div>
          )}
        </m.div>
        </ViewTransition>
      ))}
    </div>
  );
}

function AccountsTable({ accounts }: { accounts: AccountCardData[] }) {
  const t = useTranslations("cloud.accounts");
  const columns = useMemo<ColumnDef<AccountCardData, unknown>[]>(
    () => [
      {
        accessorKey: "provider",
        header: t("columns.provider"),
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <ProviderTile provider={row.original.provider} size="sm" />
            <ProviderName provider={row.original.provider} className="hidden sm:inline" />
          </span>
        ),
      },
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <ViewTransition name={accountMorphName(row.original.id)}>
              <Link
                href={`/accounts/${encodeURIComponent(row.original.id)}`}
                className="block truncate font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                title={row.original.name}
              >
                {row.original.name}
              </Link>
            </ViewTransition>
            {row.original.meta && <span className="block truncate font-mono text-xs text-muted" title={row.original.meta}>{row.original.meta}</span>}
          </div>
        ),
      },
      {
        id: "regions",
        accessorFn: (a) => a.regions.join(" "),
        header: t("columns.regions"),
        enableSorting: false,
        cell: ({ row }) => <RegionChips regions={row.original.regions} max={3} />,
      },
      {
        accessorKey: "health",
        header: t("columns.health"),
        cell: ({ row }) => <HealthBadge health={row.original.health} reasons={row.original.healthReasons} />,
      },
      {
        accessorKey: "lastSyncAt",
        header: t("columns.lastSync"),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted">{row.original.lastSyncAt ? <RelativeTime date={row.original.lastSyncAt} /> : t("never")}</span>
        ),
      },
      {
        accessorKey: "hourlyUsd",
        header: t("columns.monthlySpend"),
        cell: ({ row }) => <Spend hourlyUsd={row.original.hourlyUsd} />,
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={accounts}
      searchable
      getRowId={(a) => a.id}
      rowActions={(a) => (
        <>
          <Button asChild size="icon" variant="ghost" aria-label={t("openDetail", { name: a.name })}>
            <Link href={`/accounts/${encodeURIComponent(a.id)}`}>
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
          <DeleteAccountButton id={a.id} name={a.name} />
        </>
      )}
    />
  );
}
