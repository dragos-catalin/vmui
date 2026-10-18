"use client";

import { Badge, Button, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import { replayAuditAction } from "@/server/actions/replay";
import { History, RotateCcw } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

export interface ActionHistoryRow {
  id: number;
  createdAt: number;
  action: string;
  target: string | null;
  status: string;
  message: string | null;
  accountId: string | null;
}

const REPLAYABLE = new Set(["instance.start", "instance.stop", "instance.reboot"]);

async function replay(id: number): Promise<ActionResult> {
  const r = await replayAuditAction({ auditId: id });
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "common.error" };
}

export function ActionHistory({ rows }: { rows: ActionHistoryRow[] }) {
  const t = useTranslations("observe.actionHistory");
  const format = useFormatter();
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const action = useAction(replay, { success: t("replayed") });

  const columns: ColumnDef<ActionHistoryRow>[] = React.useMemo(
    () => [
      {
        id: "createdAt",
        header: t("columns.when"),
        cell: ({ row }) => (
          <time dateTime={new Date(row.original.createdAt).toISOString()} className="whitespace-nowrap text-xs text-fg-muted">
            {format.dateTime(new Date(row.original.createdAt), { dateStyle: "short", timeStyle: "short" })}
          </time>
        ),
      },
      { id: "action", header: t("columns.action"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
      {
        id: "target",
        header: t("columns.target"),
        cell: ({ row }) => <code className="block max-w-[14rem] truncate font-mono text-xs text-fg-muted">{row.original.target ?? "—"}</code>,
      },
      {
        id: "status",
        header: t("columns.status"),
        cell: ({ row }) => <Badge variant={row.original.status === "ok" ? "success" : "danger"}>{row.original.status}</Badge>,
      },
      {
        id: "message",
        header: t("columns.message"),
        cell: ({ row }) => <span className="block max-w-[20rem] truncate text-xs text-fg-muted">{row.original.message ?? "—"}</span>,
      },
    ],
    [t, format],
  );

  return (
    <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
      <DataTable
        columns={columns}
        data={rows}
        dense
        searchable
        getRowId={(r) => String(r.id)}
        emptyState={<EmptyState illustration="activity" compact icon={<History />} title={t("empty.title")} description={t("empty.description")} />}
        rowActions={(r) =>
          REPLAYABLE.has(r.action) ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busyId === r.id && action.pending}
              disabled={action.pending}
              onClick={async () => {
                setBusyId(r.id);
                await action.run(r.id);
                setBusyId(null);
              }}
            >
              <RotateCcw className="size-4" aria-hidden /> {t("replay")}
            </Button>
          ) : null
        }
      />
    </m.div>
  );
}
