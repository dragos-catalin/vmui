"use client";

import { ProviderName } from "@/components/cloud/provider-tile";
import { useMoney } from "@/components/costs/use-money";
import { Badge, DataTable, EmptyState, Stat, StatGrid, ToggleGroup, sortableHeader, type ColumnDef, type ToggleOption } from "@/components/ui";
import type { CostRecommendation, RecommendationKind } from "@/lib/cost-optimizer";
import { ArrowDownToLine, BedDouble, Coffee, Gauge, PiggyBank } from "lucide-react";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { useMemo, useState } from "react";

const KIND_ICON: Record<RecommendationKind, React.ComponentType<{ className?: string }>> = {
  idle: BedDouble,
  "rightsize-down": ArrowDownToLine,
  "stop-and-snapshot": Coffee,
  "reserved-instance": PiggyBank,
};

const KIND_TONE: Record<RecommendationKind, "warning" | "info" | "muted" | "success"> = {
  idle: "warning",
  "rightsize-down": "info",
  "stop-and-snapshot": "muted",
  "reserved-instance": "success",
};

const KINDS: readonly RecommendationKind[] = ["idle", "rightsize-down", "stop-and-snapshot", "reserved-instance"];
type Filter = RecommendationKind | "all";

export function CostOptimizerView({ recommendations }: { recommendations: CostRecommendation[] }) {
  const t = useTranslations("cloud.optimizer");
  const { usd } = useMoney();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => recommendations.filter((r) => filter === "all" || r.kind === filter), [recommendations, filter]);
  const total = useMemo(() => filtered.reduce((a, b) => a + b.monthlyUsd, 0), [filtered]);

  const options = useMemo<ToggleOption<Filter>[]>(
    () => [{ value: "all", label: t("kind.all") }, ...KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))],
    [t],
  );

  const columns = useMemo<ColumnDef<CostRecommendation>[]>(
    () => [
      {
        accessorKey: "kind",
        header: sortableHeader(t("columns.kind")),
        cell: ({ row }) => {
          const Icon = KIND_ICON[row.original.kind];
          return (
            <Badge variant={KIND_TONE[row.original.kind]}>
              <Icon className="size-3" aria-hidden />
              {t(`kind.${row.original.kind}`)}
            </Badge>
          );
        },
      },
      {
        accessorKey: "instanceName",
        header: sortableHeader(t("columns.instance")),
        cell: ({ row }) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium">{row.original.instanceName}</span>
            <span className="block truncate text-[11px] text-muted">
              <ProviderName provider={row.original.provider} /> · {row.original.region}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "instanceType",
        header: sortableHeader(t("columns.type")),
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span>,
      },
      {
        accessorKey: "reason",
        header: t("columns.reason"),
        enableSorting: false,
        cell: ({ getValue }) => <span className="block max-w-[24rem] text-xs text-muted">{getValue<string>()}</span>,
      },
      {
        accessorKey: "suggestion",
        header: t("columns.suggestion"),
        enableSorting: false,
        cell: ({ getValue }) => <span className="block max-w-[24rem] text-xs">{getValue<string>()}</span>,
      },
      {
        accessorKey: "monthlyUsd",
        header: sortableHeader(t("columns.monthly")),
        cell: ({ getValue }) => <span className="font-medium tabular-nums text-success">{usd(getValue<number>())}</span>,
      },
    ],
    [t, usd],
  );

  if (recommendations.length === 0) {
    return <EmptyState illustration="costs" icon={<Gauge />} title={t("empty.title")} description={t("empty.description")} />;
  }

  return (
    <div className="space-y-4">
      <StatGrid cols={3}>
        <Stat label={t("stats.count")} value={recommendations.length} />
        <Stat label={t("stats.monthly")} value={usd(total)} tone="success" icon={<PiggyBank />} />
        <Stat label={t("stats.annual")} value={usd(total * 12)} />
      </StatGrid>
      <DataTable
        columns={columns}
        data={filtered}
        searchable
        toolbar={<ToggleGroup value={filter} onValueChange={setFilter} options={options} size="sm" aria-label={t("filterLabel")} className="flex-wrap" />}
        getRowId={(r, i) => `${r.instanceId}-${r.kind}-${i}`}
        emptyState={<EmptyState compact title={t("noneForKind")} />}
      />
    </div>
  );
}
