"use client";

import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, DataTable, EmptyState, PageSection, Stat, StatGrid, sortableHeader, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { useInterval } from "@/hooks/use-poll";
import { err, ok, type ActionResult } from "@/lib/action-result";
import { deleteRegistryAction, listBuildsAction, listRegistriesAction } from "@/server/actions/builds";
import { CheckCircle2, Hammer, KeyRound, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { BuildRunCard } from "./build-run-card";
import { NewBuildForm } from "./new-build-form";
import { RegistryForm } from "./registry-form";
import type { BuildRow, InstanceLite, RegistryLite } from "./types";

export function BuildsWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.builds");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [registries, setRegistries] = useState<RegistryLite[]>([]);
  const [builds, setBuilds] = useState<BuildRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAddReg, setShowAddReg] = useState(false);
  const [showAddBuild, setShowAddBuild] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, b] = await Promise.all([listRegistriesAction(), listBuildsAction()]);
    if (r.ok) setRegistries(r.rows as RegistryLite[]);
    if (b.ok) setBuilds(b.rows as BuildRow[]);
    setLoaded(true);
  }, []);

  useInterval(() => void refresh(), 5000, { immediate: true });

  const reload = useAction(
    async (): Promise<ActionResult> => {
      await refresh();
      return ok();
    },
    { refresh: false },
  );

  const del = useAction(
    async (row: RegistryLite): Promise<ActionResult> => {
      setBusy(row.id);
      try {
        const res = await deleteRegistryAction({ id: row.id });
        if (!res.ok) return err("common.error");
        await refresh();
        return ok();
      } catch (e) {
        return err(e instanceof Error ? e.message : "common.error");
      } finally {
        setBusy(null);
      }
    },
    { success: t("registries.deleted"), refresh: false },
  );

  async function onDelete(row: RegistryLite) {
    const confirmed = await confirm({
      title: t("registries.confirmDelete.title", { name: row.name }),
      description: t("registries.confirmDelete.description"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (confirmed) await del.run(row);
  }

  const columns = useMemo<ColumnDef<RegistryLite, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: sortableHeader(t("registries.columns.name")),
        cell: ({ row }) => <span className="block max-w-[14rem] truncate font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "type",
        header: t("registries.columns.type"),
        cell: ({ row }) => <Badge variant="muted">{row.original.type.toUpperCase()}</Badge>,
      },
      {
        accessorKey: "registryUrl",
        header: t("registries.columns.url"),
        cell: ({ row }) => (
          <code className="block max-w-[20rem] truncate font-mono text-xs text-fg-muted" title={row.original.registryUrl}>
            {row.original.registryUrl}
          </code>
        ),
      },
      {
        accessorKey: "createdAt",
        header: sortableHeader(t("registries.columns.added")),
        cell: ({ row }) => <RelativeTime date={row.original.createdAt} className="whitespace-nowrap text-xs text-fg-muted" />,
      },
    ],
    [t],
  );

  const registryById = useMemo(() => new Map(registries.map((r) => [r.id, r])), [registries]);
  const instanceById = useMemo(() => new Map(instances.map((i) => [i.id, i])), [instances]);
  const active = builds.filter((b) => b.status === "running" || b.status === "pending").length;
  const succeeded = builds.filter((b) => b.status === "success").length;
  const failed = builds.filter((b) => b.status === "failed").length;

  return (
    <>
      <StatGrid cols={4}>
        <Stat label={t("stats.registries")} value={registries.length} icon={<KeyRound />} loading={!loaded} />
        <Stat label={t("stats.active")} value={active} tone={active > 0 ? "info" : "default"} icon={<Hammer />} loading={!loaded} />
        <Stat label={t("stats.succeeded")} value={succeeded} tone="success" icon={<CheckCircle2 />} loading={!loaded} />
        <Stat label={t("stats.failed")} value={failed} tone={failed > 0 ? "danger" : "default"} icon={<XCircle />} loading={!loaded} />
      </StatGrid>

      <PageSection
        title={t("registries.title")}
        description={t("registries.description")}
        action={
          <Button variant="secondary" size="sm" onClick={() => setShowAddReg((s) => !s)} aria-expanded={showAddReg}>
            <Plus className="size-4" aria-hidden /> {t("registries.add")}
          </Button>
        }
      >
        <div className="space-y-4">
          {showAddReg && (
            <RegistryForm
              onSaved={() => {
                setShowAddReg(false);
                void refresh();
              }}
              onCancel={() => setShowAddReg(false)}
            />
          )}
          <DataTable
            columns={columns}
            data={registries}
            dense
            loading={!loaded}
            searchable={registries.length > 5}
            getRowId={(r) => r.id}
            emptyState={
              <EmptyState
                compact
                icon={<KeyRound />}
                title={t("registries.empty")}
                description={t("registries.emptyHint")}
                action={
                  <Button size="sm" onClick={() => setShowAddReg(true)}>
                    <Plus className="size-4" aria-hidden /> {t("registries.add")}
                  </Button>
                }
              />
            }
            rowActions={(r) => (
              <Button variant="ghost" size="icon" aria-label={tc("delete")} loading={del.pending && busy === r.id} onClick={() => void onDelete(r)}>
                <Trash2 className="size-4 text-danger" aria-hidden />
              </Button>
            )}
          />
        </div>
      </PageSection>

      <PageSection
        title={t("runs.title")}
        description={t("runs.description")}
        action={
          <>
            <Button variant="ghost" size="sm" loading={reload.pending} onClick={() => void reload.run()}>
              <RefreshCw className="size-4" aria-hidden /> {tc("refresh")}
            </Button>
            <Button size="sm" disabled={registries.length === 0} onClick={() => setShowAddBuild((s) => !s)} aria-expanded={showAddBuild}>
              <Hammer className="size-4" aria-hidden /> {t("runs.new")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {showAddBuild && (
            <NewBuildForm
              registries={registries}
              instances={instances}
              onStarted={() => {
                setShowAddBuild(false);
                void refresh();
              }}
              onCancel={() => setShowAddBuild(false)}
            />
          )}
          {loaded && builds.length === 0 ? (
            <EmptyState
              compact
              icon={<Hammer />}
              title={t("runs.empty")}
              description={registries.length === 0 ? t("runs.emptyNeedsRegistry") : t("runs.emptyHint")}
              action={
                registries.length > 0 ? (
                  <Button size="sm" onClick={() => setShowAddBuild(true)}>
                    <Hammer className="size-4" aria-hidden /> {t("runs.new")}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setShowAddReg(true)}>
                    <Plus className="size-4" aria-hidden /> {t("registries.add")}
                  </Button>
                )
              }
            />
          ) : (
            <div className="grid gap-3">
              <AnimatePresence initial={false}>
                {builds.map((b, i) => (
                  <BuildRunCard
                    key={b.id}
                    build={b}
                    index={i}
                    registry={registryById.get(b.registryId)}
                    instance={b.instanceId ? instanceById.get(b.instanceId) : undefined}
                    expanded={expanded === b.id}
                    onToggle={() => setExpanded(expanded === b.id ? null : b.id)}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </PageSection>
    </>
  );
}
