"use client";

import { ProviderName, ProviderTile } from "@/components/cloud/provider-tile";
import { Badge, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Receipt } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

export interface AccountTrend {
  accountId: string;
  accountName: string;
  startUsdPerHour: number;
  endUsdPerHour: number;
  deltaUsdPerHour: number;
  deltaPct: number;
  monthlyDeltaUsd: number;
  startInstances: number;
  endInstances: number;
}

const EPS = 0.001;

export function BillMovers({ trends }: { trends: AccountTrend[] }) {
  const t = useTranslations("cloud.billExplainer.movers");
  const format = useFormatter();
  if (trends.length === 0) {
    return <EmptyState illustration="costs" compact icon={<Receipt />} title={t("empty.title")} description={t("empty.description")} />;
  }
  const usd = (n: number, digits = 2) => format.number(n, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {trends.slice(0, 12).map((tr, i) => {
        const dir = tr.deltaUsdPerHour > EPS ? "up" : tr.deltaUsdPerHour < -EPS ? "down" : "flat";
        const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : ArrowRight;
        const vmDelta = tr.endInstances - tr.startInstances;
        return (
          <m.li
            key={tr.accountId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i, 11) * 0.03 }}
            className="surface card-hover flex min-w-0 flex-col gap-2 p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{tr.accountName}</span>
              {vmDelta !== 0 && <Badge variant="warning">{t("vmChange", { sign: vmDelta > 0 ? "+" : "−", count: Math.abs(vmDelta) })}</Badge>}
            </div>
            <div
              className={cn(
                "flex items-baseline gap-2 text-2xl font-semibold leading-none tabular-nums",
                dir === "up" ? "text-danger" : dir === "down" ? "text-success" : "text-fg-muted",
              )}
            >
              <Icon className="size-5 shrink-0 self-center" aria-hidden />
              <span>{t("perMonth", { amount: usd(Math.abs(tr.monthlyDeltaUsd)) })}</span>
              <span className="text-sm font-medium">
                {t("pct", { value: `${tr.deltaPct >= 0 ? "+" : ""}${Math.round(tr.deltaPct)}` })}
              </span>
            </div>
            <p className="text-xs text-fg-muted tabular-nums">
              {t("range", {
                start: usd(tr.startUsdPerHour, 4),
                startVms: tr.startInstances,
                end: usd(tr.endUsdPerHour, 4),
                endVms: tr.endInstances,
              })}
            </p>
          </m.li>
        );
      })}
    </ul>
  );
}

export interface InstanceTypeRow {
  provider: string;
  type: string | null;
  count: number;
}

export function InstanceTypesTable({ rows }: { rows: InstanceTypeRow[] }) {
  const t = useTranslations("cloud.billExplainer.types");
  const columns: ColumnDef<InstanceTypeRow>[] = React.useMemo(
    () => [
      {
        id: "provider",
        header: t("columns.provider"),
        accessorFn: (r) => r.provider,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <ProviderTile provider={row.original.provider} size="sm" />
            <ProviderName provider={row.original.provider} className="text-xs" />
          </div>
        ),
      },
      {
        id: "type",
        header: t("columns.type"),
        accessorFn: (r) => r.type ?? "",
        cell: ({ row }) => <code className="font-mono text-xs">{row.original.type ?? t("unknown")}</code>,
      },
      {
        id: "count",
        header: t("columns.count"),
        accessorFn: (r) => r.count,
        cell: ({ row }) => <span className="tabular-nums">{row.original.count}</span>,
      },
    ],
    [t],
  );
  return <DataTable columns={columns} data={rows} dense getRowId={(r) => `${r.provider}:${r.type ?? ""}`} />;
}
