"use client";

import { ProviderName, ProviderTile, useProviderLabel } from "@/components/cloud/provider-tile";
import { Badge, DataTable, ToggleGroup, type ColumnDef, type ToggleOption } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CachedResourceRow } from "@/lib/db/schema";
import { formatUsd } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ResourceDetailDrawer } from "./resource-detail-drawer";
import { formatBytes, useKindLabel } from "./resource-format";

const ALL = "all";

export function ResourcesExplorer({ rows }: { rows: CachedResourceRow[] }) {
  const t = useTranslations("cloud.resources");
  const kindLabel = useKindLabel();
  const providerLabel = useProviderLabel();
  const [kind, setKind] = useState<string>(ALL);
  const [provider, setProvider] = useState<string>(ALL);
  const [selected, setSelected] = useState<CachedResourceRow | null>(null);

  const kindOptions = useMemo<ToggleOption<string>[]>(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    const opts: ToggleOption<string>[] = [
      {
        value: ALL,
        label: (
          <>
            {t("filter.all")} <Badge variant="muted">{rows.length}</Badge>
          </>
        ),
      },
    ];
    for (const [k, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      opts.push({
        value: k,
        label: (
          <>
            {kindLabel(k)} <Badge variant="muted">{n}</Badge>
          </>
        ),
      });
    }
    return opts;
  }, [rows, kindLabel, t]);

  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))].sort(), [rows]);

  const filtered = useMemo(
    () => rows.filter((r) => (kind === ALL || r.kind === kind) && (provider === ALL || r.provider === provider)),
    [rows, kind, provider],
  );

  const columns = useMemo<ColumnDef<CachedResourceRow, unknown>[]>(
    () => [
      {
        accessorKey: "kind",
        header: t("columns.kind"),
        cell: ({ row }) => <Badge variant="info">{kindLabel(row.original.kind)}</Badge>,
      },
      {
        accessorFn: (r) => r.name ?? "",
        id: "name",
        header: t("columns.name"),
        cell: ({ row }) => <span className="block max-w-[16rem] truncate font-medium" title={row.original.name ?? undefined}>{row.original.name ?? "—"}</span>,
      },
      {
        accessorKey: "externalId",
        header: t("columns.id"),
        cell: ({ row }) => <code className="block max-w-[14rem] truncate font-mono text-xs text-muted" title={row.original.externalId}>{row.original.externalId}</code>,
      },
      {
        accessorFn: (r) => providerLabel(r.provider),
        id: "provider",
        header: t("columns.provider"),
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            <ProviderTile provider={row.original.provider} size="sm" />
            <ProviderName provider={row.original.provider} className="whitespace-nowrap" />
          </span>
        ),
      },
      { accessorKey: "region", header: t("columns.region"), cell: ({ row }) => <span className="whitespace-nowrap">{row.original.region}</span> },
      {
        accessorFn: (r) => r.status ?? "",
        id: "status",
        header: t("columns.status"),
        cell: ({ row }) => (row.original.status ? <Badge variant="muted">{row.original.status}</Badge> : <span className="text-muted">—</span>),
      },
      {
        accessorFn: (r) => r.sizeBytes ?? 0,
        id: "size",
        header: t("columns.size"),
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatBytes(row.original.sizeBytes)}</span>,
      },
      {
        accessorFn: (r) => r.attachedToInstanceId ?? "",
        id: "linked",
        header: t("columns.linked"),
        cell: ({ row }) => <code className="block max-w-[12rem] truncate font-mono text-xs text-muted" title={row.original.attachedToInstanceId ?? undefined}>{row.original.attachedToInstanceId ?? "—"}</code>,
      },
      {
        accessorFn: (r) => r.monthlyUsd ?? 0,
        id: "monthly",
        header: t("columns.monthly"),
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.monthlyUsd ? formatUsd(row.original.monthlyUsd) : "—"}</span>,
      },
    ],
    [t, kindLabel, providerLabel],
  );

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={filtered}
        searchable
        getRowId={(r) => r.id}
        onRowClick={setSelected}
        toolbar={
          <>
            <div className="max-w-full overflow-x-auto">
              <ToggleGroup value={kind} onValueChange={setKind} options={kindOptions} size="sm" aria-label={t("filter.kindLabel")} />
            </div>
            {providers.length > 1 && (
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="w-44" aria-label={t("filter.providerLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("filter.allProviders")}</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>
                      {providerLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </>
        }
      />

      <ResourceDetailDrawer resource={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
