"use client";

import { Badge, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { History, Minus, Plus, RefreshCcw } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

export interface SyncEvent {
  id: string;
  provider: string;
  accountName: string;
  region: string;
  capturedAt: number;
  durationMs: number;
  total: number;
  added: number;
  removed: number;
  stateChanged: number;
  details: {
    added?: string[];
    removed?: string[];
    stateChanged?: { id: string; from: string; to: string }[];
  };
}

export function SyncHistoryTable({ rows }: { rows: SyncEvent[] }) {
  const t = useTranslations("observe.sync");
  const format = useFormatter();
  const [detail, setDetail] = React.useState<SyncEvent | null>(null);

  const columns: ColumnDef<SyncEvent>[] = React.useMemo(
    () => [
      {
        id: "capturedAt",
        header: t("columns.when"),
        cell: ({ row }) => (
          <time dateTime={new Date(row.original.capturedAt).toISOString()} className="whitespace-nowrap text-xs text-fg-muted">
            {format.dateTime(new Date(row.original.capturedAt), { dateStyle: "short", timeStyle: "short" })}
          </time>
        ),
      },
      {
        id: "account",
        header: t("columns.account"),
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="info">{row.original.provider}</Badge>
            <span className="min-w-0 truncate">{row.original.accountName}</span>
          </div>
        ),
      },
      {
        id: "region",
        header: t("columns.region"),
        cell: ({ row }) => <code className="font-mono text-xs">{row.original.region}</code>,
      },
      {
        id: "delta",
        header: t("columns.delta"),
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
            {row.original.added > 0 && (
              <span className="inline-flex items-center gap-1 text-success">
                <Plus className="size-3" aria-hidden />
                {row.original.added}
              </span>
            )}
            {row.original.removed > 0 && (
              <span className="inline-flex items-center gap-1 text-danger">
                <Minus className="size-3" aria-hidden />
                {row.original.removed}
              </span>
            )}
            {row.original.stateChanged > 0 && (
              <span className="inline-flex items-center gap-1 text-warning">
                <RefreshCcw className="size-3" aria-hidden />
                {row.original.stateChanged}
              </span>
            )}
            {row.original.added + row.original.removed + row.original.stateChanged === 0 && <span className="text-fg-muted">—</span>}
          </div>
        ),
      },
      {
        id: "total",
        header: t("columns.total"),
        cell: ({ row }) => <span className="tabular-nums text-xs">{row.original.total}</span>,
      },
      {
        id: "duration",
        header: t("columns.duration"),
        cell: ({ row }) => <span className="tabular-nums text-xs text-fg-muted">{t("ms", { n: row.original.durationMs })}</span>,
      },
    ],
    [t, format],
  );

  return (
    <>
      <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
        <DataTable
          columns={columns}
          data={rows}
          dense
          searchable
          getRowId={(r) => r.id}
          onRowClick={setDetail}
          emptyState={<EmptyState illustration="activity" compact icon={<History />} title={t("empty.title")} description={t("empty.description")} />}
        />
      </m.div>

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        {detail && (
          <SheetContent
            title={`${detail.accountName} · ${detail.region}`}
            description={format.dateTime(new Date(detail.capturedAt), { dateStyle: "full", timeStyle: "medium" })}
          >
            <DetailGroup title={t("detail.added")} tone="text-success" items={detail.details.added ?? []} />
            <DetailGroup title={t("detail.removed")} tone="text-danger" items={detail.details.removed ?? []} />
            <DetailGroup
              title={t("detail.stateChanged")}
              tone="text-warning"
              items={(detail.details.stateChanged ?? []).map((s) => `${s.id}: ${s.from} → ${s.to}`)}
            />
            {(detail.details.added?.length ?? 0) + (detail.details.removed?.length ?? 0) + (detail.details.stateChanged?.length ?? 0) === 0 && (
              <EmptyState compact title={t("detail.noChanges")} />
            )}
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}

function DetailGroup({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className={`mb-1 text-[11px] font-semibold uppercase tracking-wider ${tone}`}>{title}</h3>
      <ul className="space-y-0.5 font-mono text-xs text-fg-muted">
        {items.map((it) => (
          <li key={it} className="truncate" title={it}>
            {it}
          </li>
        ))}
      </ul>
    </section>
  );
}
