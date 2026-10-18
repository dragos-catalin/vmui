"use client";

import { Badge, Button, Checkbox, DataTable, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatUsd } from "@/lib/utils";
import { bulkDeleteResourcesAction } from "@/server/actions/bulk-resources";
import { Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatBytes, useKindLabel } from "./resource-format";

export interface CleanupRow {
  id: string;
  externalId: string;
  region: string;
  kind: string;
  name: string | null;
  sizeBytes: number | null;
  status: string | null;
  monthlyUsd: number | null;
}

export function ResourceCleanupTable({ rows }: { rows: CleanupRow[] }) {
  const t = useTranslations("cloud.cleanup");
  const kindLabel = useKindLabel();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCount = selected.size;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const totalSavings = rows.filter((r) => selected.has(r.id)).reduce((s, r) => s + (r.monthlyUsd ?? 0), 0);

  const columns = useMemo<ColumnDef<CleanupRow, unknown>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => (
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            aria-label={t("selectAll")}
            onCheckedChange={(checked) => setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set())}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.id)}
            aria-label={t("selectRow", { name: row.original.name ?? row.original.externalId })}
            onCheckedChange={() => toggle(row.original.id)}
          />
        ),
      },
      {
        accessorFn: (r) => `${r.name ?? ""} ${r.externalId}`,
        id: "resource",
        header: t("columns.resource"),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="info">{kindLabel(row.original.kind)}</Badge>
              <span className="truncate font-medium">{row.original.name ?? row.original.externalId}</span>
            </div>
            <code className="block max-w-[16rem] truncate font-mono text-xs text-muted">{row.original.externalId}</code>
          </div>
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
        accessorFn: (r) => r.monthlyUsd ?? 0,
        id: "cost",
        header: t("columns.cost"),
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.monthlyUsd ? formatUsd(row.original.monthlyUsd) : "—"}</span>,
      },
    ],
    [rows, selected, allSelected, someSelected, t, kindLabel],
  );

  async function deleteSelected() {
    const proceed = await confirm({
      title: t("confirm.title", { count: selectedCount }),
      description: t("confirm.description"),
      tone: "danger",
      confirmText: t("confirm.action"),
    });
    if (!proceed) return;
    startTransition(async () => {
      const r = await bulkDeleteResourcesAction({ resourceIds: [...selected] });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.failed.length > 0) toast.warning(t("partial", { deleted: r.deleted, failed: r.failed.length }));
      else toast.success(t("deleted", { count: r.deleted }));
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <DataTable columns={columns} data={rows} getRowId={(r) => r.id} />

      <AnimatePresence>
        {selectedCount > 0 && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="surface sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 p-3 shadow-[var(--shadow-lg)]"
          >
            <span className="text-sm tabular-nums">{t("selected", { count: selectedCount, savings: formatUsd(totalSavings) })}</span>
            <Button variant="danger" size="sm" loading={pending} onClick={() => void deleteSelected()}>
              <Trash2 className="size-3.5" aria-hidden />
              {t("deleteSelected")}
            </Button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
