"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { Alert, Badge, Button, DataTable, EmptyState, Switch, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { useEventSource } from "@/hooks/use-poll";
import { err, ok, type ActionResult } from "@/lib/action-result";
import type { ContainerListResult, ContainerRow } from "@/lib/containers";
import { containerActionAction, inspectContainerAction } from "@/server/actions/containers";
import { Boxes, Download, FileText, Play, RotateCcw, Search, Square, TerminalSquare, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export interface HostSummary {
  runtime: string | null;
  total: number;
  running: number;
  stopped: number;
}

type ContainerVerb = "start" | "stop" | "restart" | "remove" | "pull";

const STATE_VARIANT: Record<string, "success" | "muted" | "info" | "warning" | "danger"> = {
  running: "success",
  exited: "muted",
  created: "info",
  paused: "warning",
  dead: "danger",
  restarting: "info",
};

export function ContainerPanel({
  instanceId,
  onSummary,
}: {
  instanceId: string;
  onSummary?: (instanceId: string, summary: HostSummary) => void;
}) {
  const t = useTranslations("ops.containers");
  const confirm = useConfirm();
  const statsId = useId();
  const [data, setData] = useState<ContainerListResult | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<ContainerRow | null>(null);
  const [inspectFor, setInspectFor] = useState<{ row: ContainerRow; data: unknown } | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const qs = showStats ? "interval=10&stats=1" : "interval=5";
  useEventSource<ContainerListResult | { message?: string }>(`/api/instances/${encodeURIComponent(instanceId)}/containers/stream?${qs}`, {
    // the server also sends a named `error` event carrying { message }
    events: ["snapshot", "error"],
    onMessage: (payload, event) => {
      if (event === "snapshot") {
        setData(payload as ContainerListResult);
        setStreamError(null);
      } else {
        const msg = (payload as { message?: string }).message;
        if (msg) setStreamError(msg);
      }
    },
  });

  const summaryRef = useRef(onSummary);
  summaryRef.current = onSummary;
  useEffect(() => {
    if (!data) return;
    const running = data.rows.filter((r) => r.state === "running").length;
    summaryRef.current?.(instanceId, {
      runtime: data.runtime,
      total: data.rows.length,
      running,
      stopped: data.rows.length - running,
    });
  }, [data, instanceId]);

  const verb = useAction(
    async (row: ContainerRow, action: ContainerVerb, label: string): Promise<ActionResult<string>> => {
      setBusy(`${row.id || row.name}:${action}`);
      const res = await containerActionAction({ instanceId, containerId: row.id || row.name, action });
      setBusy(null);
      if (res.ok) return ok(label);
      return err(res.error ?? (res.output ? res.output.slice(0, 200) : "common.error"));
    },
    { success: (message) => message, refresh: false },
  );

  const runVerb = useCallback(
    async (row: ContainerRow, action: ContainerVerb) => {
      const name = row.name || row.id;
      if (action === "remove" || action === "stop") {
        const confirmed = await confirm({
          title: action === "remove" ? t("confirmRemove.title", { name }) : t("confirmStop.title", { name }),
          description: action === "remove" ? t("confirmRemove.description") : t("confirmStop.description"),
          tone: action === "remove" ? "danger" : "warning",
          confirmText: action === "remove" ? t("actions.remove") : t("actions.stop"),
        });
        if (!confirmed) return;
      }
      await verb.run(row, action, t(`done.${action}`));
    },
    [confirm, t, verb],
  );

  const inspect = useCallback(
    async (row: ContainerRow) => {
      const res = await inspectContainerAction({ instanceId, containerId: row.id || row.name });
      if (!res.ok) {
        toast.error(res.error ?? t("inspect.failed"));
        return;
      }
      setInspectFor({ row, data: res.data });
    },
    [instanceId, t],
  );

  const columns = useMemo<ColumnDef<ContainerRow, unknown>[]>(() => {
    const base: ColumnDef<ContainerRow, unknown>[] = [
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => (
          <span className="block max-w-[16rem] truncate font-medium" title={row.original.name || row.original.id}>
            {row.original.name || row.original.id}
          </span>
        ),
      },
      {
        accessorKey: "image",
        header: t("columns.image"),
        cell: ({ row }) => (
          <code className="block max-w-[18rem] truncate font-mono text-xs text-fg-muted" title={row.original.image}>
            {row.original.image}
          </code>
        ),
      },
      {
        accessorKey: "state",
        header: t("columns.status"),
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant={STATE_VARIANT[row.original.state] ?? "muted"} dot={row.original.state === "running"}>
              {row.original.state || "—"}
            </Badge>
            <span className="truncate text-xs text-fg-muted">{row.original.status}</span>
          </span>
        ),
      },
    ];
    if (showStats) {
      base.push(
        {
          accessorKey: "cpuPct",
          header: t("columns.cpu"),
          cell: ({ row }) => (
            <span className="tabular-nums text-xs">{row.original.cpuPct != null ? `${row.original.cpuPct.toFixed(1)}%` : "—"}</span>
          ),
        },
        {
          accessorKey: "memPct",
          header: t("columns.memory"),
          cell: ({ row }) => (
            <span className="tabular-nums text-xs" title={row.original.memUsage}>
              {row.original.memPct != null ? `${row.original.memPct.toFixed(1)}%` : "—"}
            </span>
          ),
        },
        {
          accessorKey: "netIo",
          header: t("columns.network"),
          enableSorting: false,
          cell: ({ row }) => <span className="font-mono text-xs text-fg-muted">{row.original.netIo || "—"}</span>,
        },
      );
    }
    base.push({
      accessorKey: "ports",
      header: t("columns.ports"),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block max-w-[14rem] truncate font-mono text-xs text-fg-muted" title={row.original.ports}>
          {row.original.ports || "—"}
        </span>
      ),
    });
    return base;
  }, [showStats, t]);

  if (streamError && !data) {
    return <Alert tone="danger">{streamError}</Alert>;
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
        <span className="pulse-dot inline-block size-1.5 rounded-full bg-warning" aria-hidden />
        {t("connecting")}
      </div>
    );
  }
  if (data.runtime === null) {
    return <Alert tone="warning">{data.warning ?? t("noRuntime")}</Alert>;
  }

  const logsRow = logsFor;
  const inspectRow = inspectFor;

  return (
    <div className="space-y-3">
      {streamError && <Alert tone="warning">{streamError}</Alert>}
      <DataTable
        columns={columns}
        data={data.rows}
        dense
        searchable={data.rows.length > 5}
        getRowId={(r) => r.id || r.name}
        toolbar={
          <label htmlFor={statsId} className="flex items-center gap-2 text-xs text-muted">
            <Switch id={statsId} checked={showStats} onCheckedChange={setShowStats} />
            {t("liveStats")}
          </label>
        }
        emptyState={
          <EmptyState
            compact
            icon={<Boxes />}
            title={t("empty.title")}
            description={t("empty.description")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.open(`/terminal?instance=${encodeURIComponent(instanceId)}`, "_blank", "noopener")}
              >
                <TerminalSquare className="size-4" aria-hidden /> {t("empty.action")}
              </Button>
            }
          />
        }
        rowActions={(row) => {
          const key = row.id || row.name;
          const isRunning = row.state === "running";
          return (
            <>
              {!isRunning && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("actions.start")}
                  title={t("actions.start")}
                  loading={verb.pending && busy === `${key}:start`}
                  onClick={() => void runVerb(row, "start")}
                >
                  <Play className="size-4" aria-hidden />
                </Button>
              )}
              {isRunning && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("actions.stop")}
                  title={t("actions.stop")}
                  loading={verb.pending && busy === `${key}:stop`}
                  onClick={() => void runVerb(row, "stop")}
                >
                  <Square className="size-4" aria-hidden />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("actions.restart")}
                title={t("actions.restart")}
                loading={verb.pending && busy === `${key}:restart`}
                onClick={() => void runVerb(row, "restart")}
              >
                <RotateCcw className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("actions.pull")}
                title={t("actions.pull")}
                loading={verb.pending && busy === `${key}:pull`}
                onClick={() => void runVerb(row, "pull")}
              >
                <Download className="size-4" aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t("actions.logs")} title={t("actions.logs")} onClick={() => setLogsFor(row)}>
                <FileText className="size-4" aria-hidden />
              </Button>
              {isRunning && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("actions.exec")}
                  title={t("actions.exec")}
                  onClick={() =>
                    window.open(
                      `/terminal?instance=${encodeURIComponent(instanceId)}&container=${encodeURIComponent(row.id || row.name)}`,
                      "_blank",
                      "noopener",
                    )
                  }
                >
                  <TerminalSquare className="size-4" aria-hidden />
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label={t("actions.inspect")} title={t("actions.inspect")} onClick={() => void inspect(row)}>
                <Search className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("actions.remove")}
                title={t("actions.remove")}
                loading={verb.pending && busy === `${key}:remove`}
                onClick={() => void runVerb(row, "remove")}
              >
                <Trash2 className="size-4 text-danger" aria-hidden />
              </Button>
            </>
          );
        }}
      />

      <Sheet open={logsRow !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
        {logsRow && (
          <SheetContent title={t("logs.title", { name: logsRow.name || logsRow.id })} className="md:w-[min(56rem,92vw)]">
            <ContainerLogs instanceId={instanceId} row={logsRow} />
          </SheetContent>
        )}
      </Sheet>

      <Sheet open={inspectRow !== null} onOpenChange={(open) => !open && setInspectFor(null)}>
        {inspectRow && (
          <SheetContent title={t("inspect.title", { name: inspectRow.row.name || inspectRow.row.id })} className="md:w-[min(56rem,92vw)]">
            <LogViewer text={JSON.stringify(inspectRow.data, null, 2)} height="h-[70dvh]" autoScroll={false} wrap />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

function ContainerLogs({ instanceId, row }: { instanceId: string; row: ContainerRow }) {
  const t = useTranslations("ops.containers");
  const [lines, setLines] = useState<string[]>([]);
  const url = `/api/instances/${encodeURIComponent(instanceId)}/containers/${encodeURIComponent(row.id || row.name)}/logs?rt=${row.runtime}`;
  useEventSource<{ line?: string }>(url, {
    events: ["log"],
    onOpen: () => setLines([]),
    onMessage: ({ line }) => {
      if (typeof line !== "string") return;
      setLines((prev) => (prev.length > 1000 ? [...prev.slice(-800), line] : [...prev, line]));
    },
  });

  return <LogViewer lines={lines} height="h-[70dvh]" loading={lines.length === 0} emptyLabel={t("logs.empty")} />;
}
