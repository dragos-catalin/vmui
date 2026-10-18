"use client";

import { Button, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { Download, Play, TerminalSquare } from "lucide-react";
import * as Mo from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";

export interface RecordingItem {
  id: string;
  startedAt: number;
  instanceLabel: string | null;
  sizeBytes: number;
  durationMs: number;
  cols: number;
  rows: number;
}

export function formatBytes(format: ReturnType<typeof useFormatter>, n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${format.number(n / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${format.number(n / 1024 / 1024, { maximumFractionDigits: 2 })} MB`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RecordingsTable({ rows }: { rows: RecordingItem[] }) {
  const t = useTranslations("observe.recordings");
  const format = useFormatter();

  const columns: ColumnDef<RecordingItem>[] = React.useMemo(
    () => [
      {
        id: "startedAt",
        header: t("columns.when"),
        cell: ({ row }) => (
          <time dateTime={new Date(row.original.startedAt).toISOString()} className="whitespace-nowrap text-xs text-fg-muted">
            {format.dateTime(new Date(row.original.startedAt), { dateStyle: "short", timeStyle: "short" })}
          </time>
        ),
      },
      {
        id: "label",
        header: t("columns.label"),
        cell: ({ row }) => <span className="block max-w-[16rem] truncate">{row.original.instanceLabel ?? "—"}</span>,
      },
      {
        id: "duration",
        header: t("columns.duration"),
        cell: ({ row }) => <span className="font-mono text-xs tabular-nums">{formatDuration(row.original.durationMs)}</span>,
      },
      {
        id: "size",
        header: t("columns.size"),
        cell: ({ row }) => <span className="font-mono text-xs tabular-nums">{formatBytes(format, row.original.sizeBytes)}</span>,
      },
      {
        id: "term",
        header: t("columns.term"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">
            {row.original.cols}×{row.original.rows}
          </span>
        ),
      },
    ],
    [t, format],
  );

  return (
    <Mo.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
      <DataTable
        columns={columns}
        data={rows}
        dense
        searchable
        getRowId={(r) => r.id}
        emptyState={<EmptyState compact icon={<TerminalSquare />} title={t("empty.title")} description={t("empty.description")} />}
        rowActions={(r) => (
          <>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`/recordings/${r.id}/play`}>
                <Play className="size-4" aria-hidden /> {t("play")}
              </Link>
            </Button>
            <Button size="icon" variant="ghost" asChild>
              <a href={`/api/recordings/${r.id}`} download aria-label={t("download")} title={t("download")}>
                <Download className="size-4" aria-hidden />
              </a>
            </Button>
          </>
        )}
      />
    </Mo.div>
  );
}
