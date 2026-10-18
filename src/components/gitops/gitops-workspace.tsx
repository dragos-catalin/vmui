"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { toResult } from "@/components/settings/adapt";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, DataTable, EmptyState, PageHeader, PageSection, PageShell, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { useInterval } from "@/hooks/use-poll";
import {
    deleteGitSourceAction,
    listGitHistoryAction,
    listGitSourcesAction,
    syncGitSourceNowAction,
    toggleGitSourceAction,
} from "@/server/actions/gitops";
import { GitBranch, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { SourceForm } from "./source-form";
import { SyncTimeline, sourceState } from "./sync-timeline";
import type { GitSourceLite, HistoryRow, InstanceLite } from "./types";

const STATUS_VARIANT = { done: "success", running: "info", failed: "danger", idle: "muted" } as const;

export function GitopsWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.gitops");
  const tc = useTranslations("common");
  const format = useFormatter();
  const confirm = useConfirm();
  const [sources, setSources] = useState<GitSourceLite[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, h] = await Promise.all([listGitSourcesAction(), listGitHistoryAction({})]);
    if (s.ok) setSources(s.rows as GitSourceLite[]);
    if (h.ok) setHistory(h.rows as HistoryRow[]);
    setLoaded(true);
  }, []);

  useInterval(() => void refresh(), 5000, { immediate: true });

  const sync = useAction(async (id: string) => toResult(await syncGitSourceNowAction({ id })), {
    success: t("toast.synced"),
    refresh: false,
    onSuccess: () => void refresh(),
  });
  const toggle = useAction(async (id: string, enabled: boolean) => toResult(await toggleGitSourceAction({ id, enabled })), {
    refresh: false,
    onSuccess: () => void refresh(),
  });
  const del = useAction(async (id: string) => toResult(await deleteGitSourceAction({ id })), {
    success: t("toast.deleted"),
    refresh: false,
    onSuccess: () => {
      setSelectedId(null);
      void refresh();
    },
  });

  const runBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (src: GitSourceLite) => {
    const yes = await confirm({
      title: t("confirmDelete.title", { name: src.name }),
      description: t("confirmDelete.description"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await runBusy(src.id, () => del.run(src.id));
  };

  const selected = useMemo(() => sources.find((s) => s.id === selectedId) ?? sources[0] ?? null, [sources, selectedId]);
  const selectedHistory = useMemo(() => (selected ? history.filter((h) => h.sourceId === selected.id) : []), [history, selected]);
  const syncingId = sync.pending ? busy : null;

  const logLines = useMemo(() => {
    if (!selected) return [];
    const lines = [...selectedHistory]
      .reverse()
      .map(
        (h) =>
          `${format.dateTime(new Date(h.createdAt), { dateStyle: "short", timeStyle: "medium" })}  ${h.status.toUpperCase().padEnd(7)}  ${h.commit.slice(0, 8)}  ${h.path}${h.message ? `  — ${h.message}` : ""}`,
      );
    if (selected.lastError) lines.push(`ERROR    ${selected.lastError}`);
    return lines;
  }, [selected, selectedHistory, format]);

  const columns = useMemo<ColumnDef<GitSourceLite, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <GitBranch className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="truncate" title={row.original.name}>{row.original.name}</span>
          </span>
        ),
      },
      {
        id: "repo",
        accessorFn: (s) => `${s.url}@${s.branch}`,
        header: t("columns.repo"),
        cell: ({ row }) => (
          <span className="block max-w-[28rem] truncate font-mono text-xs text-fg-muted" title={`${row.original.url}@${row.original.branch}`}>
            {row.original.url}
            <span className="text-fg-soft">@{row.original.branch}</span>
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (s) => sourceState(s, false),
        header: t("columns.status"),
        cell: ({ row }) => {
          const state = sourceState(row.original, syncingId === row.original.id);
          return (
            <Badge variant={STATUS_VARIANT[state]} dot={state === "running"}>
              {t(`stepState.${state}`)}
            </Badge>
          );
        },
      },
      {
        accessorKey: "lastSyncedAt",
        header: t("columns.lastSync"),
        cell: ({ row }) =>
          row.original.lastSyncedAt ? (
            <RelativeTime date={row.original.lastSyncedAt} className="whitespace-nowrap text-fg-muted" />
          ) : (
            <span className="text-fg-muted">{t("steps.never")}</span>
          ),
      },
      {
        accessorKey: "lastCommit",
        header: t("columns.commit"),
        cell: ({ row }) => <span className="font-mono text-xs text-fg-muted">{row.original.lastCommit?.slice(0, 8) ?? "—"}</span>,
      },
    ],
    [t, syncingId],
  );

  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<GitBranch />}
        badge={loaded ? <Badge variant="muted">{t("count", { count: sources.length })}</Badge> : undefined}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-4" aria-hidden />
              {tc("refresh")}
            </Button>
            <Button size="sm" onClick={() => setShowAdd((v) => !v)} aria-expanded={showAdd}>
              <Plus className="size-4" aria-hidden />
              {t("addSource")}
            </Button>
          </>
        }
      />

      <AnimatePresence initial={false}>
        {showAdd && (
          <m.div key="add" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
            <SourceForm
              instances={instances}
              onCancel={() => setShowAdd(false)}
              onSaved={() => {
                setShowAdd(false);
                void refresh();
              }}
            />
          </m.div>
        )}
      </AnimatePresence>

      <PageSection title={t("sources.title")} description={t("sources.description")}>
        <DataTable
          columns={columns}
          data={sources}
          loading={!loaded}
          dense
          searchable={sources.length > 5}
          getRowId={(s) => s.id}
          onRowClick={(s) => setSelectedId(s.id)}
          emptyState={
            <EmptyState
              compact
              icon={<GitBranch />}
              title={t("empty.title")}
              description={t("empty.description")}
              action={
                <Button size="sm" onClick={() => setShowAdd(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t("addSource")}
                </Button>
              }
            />
          }
          rowActions={(s) => (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("actions.syncNow")}
                title={t("actions.syncNow")}
                loading={sync.pending && busy === s.id}
                onClick={() => void runBusy(s.id, () => sync.run(s.id))}
              >
                <RefreshCw className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={s.enabled ? t("actions.pause") : t("actions.resume")}
                title={s.enabled ? t("actions.pause") : t("actions.resume")}
                loading={toggle.pending && busy === s.id}
                onClick={() => void runBusy(s.id, () => toggle.run(s.id, !s.enabled))}
              >
                {s.enabled ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              </Button>
              <Button variant="ghost" size="icon" aria-label={tc("delete")} title={tc("delete")} loading={del.pending && busy === s.id} onClick={() => void onDelete(s)}>
                <Trash2 className="size-4 text-danger" aria-hidden />
              </Button>
            </>
          )}
        />
      </PageSection>

      {selected && (
        <PageSection
          title={t("pipeline.title", { name: selected.name })}
          description={t("pipeline.description")}
          action={
            <Badge variant={selected.enabled ? "success" : "muted"} dot={selected.enabled}>
              {selected.enabled ? t("enabled") : t("paused")}
            </Badge>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <SyncTimeline src={selected} history={selectedHistory} syncing={syncingId === selected.id} />
            <LogViewer
              title={t("log.title")}
              lines={logLines}
              height="max-h-72"
              emptyLabel={t("log.empty")}
              loading={syncingId === selected.id}
              lineTone={(line) =>
                line.includes("FAILED") || line.startsWith("ERROR") ? "danger" : line.includes("SKIPPED") ? "muted" : line.includes("SUCCESS") ? "success" : undefined
              }
            />
          </div>
        </PageSection>
      )}
    </PageShell>
  );
}
