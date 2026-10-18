"use client";

import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, DataTable, EmptyState, Field, Input, Switch, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { useInterval } from "@/hooks/use-poll";
import { ok, type ActionResult } from "@/lib/action-result";
import { verifyBackupJobAction } from "@/server/actions/backup-verify";
import {
    createBackupPolicyAction,
    deleteBackupPolicyAction,
    listBackupJobsAction,
    listBackupPoliciesAction,
    runBackupNowAction,
    toggleBackupPolicyAction,
} from "@/server/actions/backups";
import { Archive, CloudUpload, Globe, HardDrive, ListTree, Play, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "./bytes";

type BackupKind = "cloud-snapshot" | "s3-dump" | "local-copy" | "cross-region";
const KINDS: BackupKind[] = ["cloud-snapshot", "s3-dump", "local-copy", "cross-region"];

interface PolicyLite {
  id: string;
  name: string;
  kind: BackupKind;
  instanceId: string;
  cronExpr: string;
  retentionJson: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
  createdAt: Date;
}

interface JobLite {
  id: string;
  policyId: string;
  status: "queued" | "running" | "ok" | "error";
  startedAt: Date;
  finishedAt: Date | null;
  artifactRef: string | null;
  sizeBytes: number | null;
  message: string | null;
}

interface InstanceLite {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
}

const KIND_ICON: Record<BackupKind, typeof Archive> = {
  "cloud-snapshot": Archive,
  "s3-dump": CloudUpload,
  "local-copy": HardDrive,
  "cross-region": Globe,
};

const STATUS_VARIANT: Record<string, "success" | "danger" | "info" | "muted"> = {
  ok: "success",
  error: "danger",
  running: "info",
  queued: "muted",
};

function parseRetention(json: string): { keepDaily: number; keepWeekly: number; keepMonthly: number } {
  try {
    return JSON.parse(json) as { keepDaily: number; keepWeekly: number; keepMonthly: number };
  } catch {
    return { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 };
  }
}

export function BackupsWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.backups.policies");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [policies, setPolicies] = useState<PolicyLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<PolicyLite | null>(null);

  const refresh = useCallback(async () => {
    const rows = (await listBackupPoliciesAction()) as PolicyLite[];
    setPolicies(rows);
    setLoaded(true);
  }, []);

  useInterval(() => void refresh(), 5000, { immediate: true });

  const instanceName = useCallback(
    (iid: string) => {
      const i = instances.find((x) => x.id === iid);
      return i ? `${i.name ?? i.providerInstanceId} (${i.provider})` : iid;
    },
    [instances],
  );

  const runNow = useAction(
    async (id: string): Promise<ActionResult> => {
      const r = await runBackupNowAction(id);
      await refresh();
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("queued"), refresh: false },
  );
  const toggle = useAction(
    async (id: string, enabled: boolean): Promise<ActionResult> => {
      await toggleBackupPolicyAction(id, enabled);
      await refresh();
      return ok();
    },
    { refresh: false },
  );
  const remove = useAction(
    async (id: string): Promise<ActionResult> => {
      await deleteBackupPolicyAction(id);
      await refresh();
      return ok();
    },
    { success: t("deleted"), refresh: false },
  );

  async function onRemove(p: PolicyLite) {
    const yes = await confirm({
      title: t("confirmDelete", { name: p.name }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(p.id);
  }

  const columns = useMemo<ColumnDef<PolicyLite, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => {
          const Icon = KIND_ICON[row.original.kind];
          return (
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0">
                <span className="block truncate font-medium">{row.original.name}</span>
                <span className="block truncate text-xs text-fg-muted">{t(`kinds.${row.original.kind}`)}</span>
              </div>
            </div>
          );
        },
      },
      {
        id: "target",
        accessorFn: (p) => instanceName(p.instanceId),
        header: t("columns.target"),
        cell: ({ row }) => <span className="block max-w-[16rem] truncate text-xs">{instanceName(row.original.instanceId)}</span>,
      },
      {
        accessorKey: "cronExpr",
        header: t("columns.cron"),
        cell: ({ row }) => <code className="whitespace-nowrap font-mono text-xs">{row.original.cronExpr}</code>,
      },
      {
        accessorKey: "lastRunAt",
        header: t("columns.lastRun"),
        cell: ({ row }) =>
          row.original.lastRunAt ? (
            <RelativeTime date={row.original.lastRunAt} className="whitespace-nowrap text-fg-muted" />
          ) : (
            <span className="text-xs text-fg-muted">{t("never")}</span>
          ),
      },
      {
        accessorKey: "lastStatus",
        header: t("columns.status"),
        cell: ({ row }) =>
          row.original.lastStatus ? (
            <Badge variant={STATUS_VARIANT[row.original.lastStatus] ?? "muted"} dot={row.original.lastStatus === "running"}>
              {t(`status.${row.original.lastStatus}`)}
            </Badge>
          ) : (
            <span className="text-xs text-fg-muted">—</span>
          ),
      },
      {
        accessorKey: "enabled",
        header: t("columns.enabled"),
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={toggle.pending}
            onCheckedChange={(v) => void toggle.run(row.original.id, v)}
            aria-label={row.original.enabled ? t("disable") : t("enable")}
          />
        ),
      },
    ],
    [t, instanceName, toggle.run, toggle.pending],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-4" aria-hidden /> {tc("refresh")}
        </Button>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="size-4" aria-hidden /> {t("add")}
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={policies}
        loading={!loaded}
        dense
        searchable={policies.length > 5}
        getRowId={(p) => p.id}
        onRowClick={(p) => setDetail(p)}
        emptyState={
          <EmptyState
            compact
            icon={<Archive />}
            title={t("empty")}
            description={t("emptyHint")}
            action={
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="size-4" aria-hidden /> {t("add")}
              </Button>
            }
          />
        }
        rowActions={(p) => (
          <>
            <Button size="icon" variant="ghost" onClick={() => setDetail(p)} aria-label={t("jobs")}>
              <ListTree className="size-4" aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void runNow.run(p.id)} disabled={runNow.pending} aria-label={t("runNow")}>
              <Play className="size-4" aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void onRemove(p)} disabled={remove.pending} aria-label={tc("delete")}>
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </>
        )}
      />

      <Sheet open={showAdd} onOpenChange={setShowAdd}>
        <SheetContent title={t("newTitle")} description={t("newDescription")} className="md:w-[560px]">
          <AddPolicyForm
            instances={instances}
            onDone={() => {
              setShowAdd(false);
              void refresh();
            }}
          />
        </SheetContent>
      </Sheet>

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        {detail && (
          <SheetContent title={detail.name} description={instanceName(detail.instanceId)} className="md:w-[640px]">
            <PolicyDetail policy={detail} />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

function PolicyDetail({ policy }: { policy: PolicyLite }) {
  const t = useTranslations("ops.backups.policies");
  const [jobs, setJobs] = useState<JobLite[] | null>(null);
  const retention = useMemo(() => parseRetention(policy.retentionJson), [policy.retentionJson]);

  const load = useCallback(async () => {
    setJobs((await listBackupJobsAction(policy.id)) as JobLite[]);
  }, [policy.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = useAction(
    async (jobId: string): Promise<ActionResult<string>> => {
      const r = await verifyBackupJobAction({ jobId });
      if (r.ok) return ok(("message" in r && r.message) || t("verified"));
      return { ok: false, error: ("error" in r && r.error) || t("verifyFailed") };
    },
    { success: (m) => m, refresh: false },
  );

  const columns = useMemo<ColumnDef<JobLite, unknown>[]>(
    () => [
      {
        accessorKey: "startedAt",
        header: t("jobColumns.started"),
        cell: ({ row }) => <RelativeTime date={row.original.startedAt} className="whitespace-nowrap text-fg-muted" />,
      },
      {
        accessorKey: "status",
        header: t("jobColumns.status"),
        cell: ({ row }) => (
          <Badge variant={STATUS_VARIANT[row.original.status] ?? "muted"} dot={row.original.status === "running"}>
            {t(`status.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        accessorKey: "artifactRef",
        header: t("jobColumns.artifact"),
        enableSorting: false,
        cell: ({ row }) => (
          <code className="block max-w-[14rem] truncate font-mono text-xs" title={row.original.artifactRef ?? undefined}>
            {row.original.artifactRef ?? "—"}
          </code>
        ),
      },
      {
        accessorKey: "sizeBytes",
        header: t("jobColumns.size"),
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums text-xs">{formatBytes(row.original.sizeBytes)}</span>,
      },
      {
        accessorKey: "message",
        header: t("jobColumns.message"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="block max-w-[16rem] truncate text-xs text-fg-muted" title={row.original.message ?? undefined}>
            {row.original.message ?? ""}
          </span>
        ),
      },
    ],
    [t],
  );

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-fg-muted">{t("columns.cron")}</dt>
          <dd className="font-mono text-xs">{policy.cronExpr}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">{t("retention")}</dt>
          <dd className="font-mono text-xs">
            {t("retentionValue", { d: retention.keepDaily, w: retention.keepWeekly, m: retention.keepMonthly })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">{t("columns.enabled")}</dt>
          <dd>
            <Badge variant={policy.enabled ? "success" : "muted"}>{policy.enabled ? t("enabledYes") : t("enabledNo")}</Badge>
          </dd>
        </div>
      </dl>
      {policy.lastError && (
        <p className="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_12%,transparent)] px-3 py-2 text-xs text-danger">
          {t("lastError", { error: policy.lastError })}
        </p>
      )}
      <DataTable
        columns={columns}
        data={jobs ?? []}
        loading={jobs === null}
        dense
        pageSize={10}
        getRowId={(j) => j.id}
        emptyState={<EmptyState compact icon={<ListTree />} title={t("noJobs")} />}
        rowActions={(j) => (
          <Button
            size="sm"
            variant="outline"
            disabled={j.status !== "ok" || verify.pending}
            onClick={() => void verify.run(j.id)}
            aria-label={t("verify")}
          >
            <ShieldCheck className="size-3.5" aria-hidden /> {t("verify")}
          </Button>
        )}
      />
    </div>
  );
}

function AddPolicyForm({ instances, onDone }: { instances: InstanceLite[]; onDone: () => void }) {
  const t = useTranslations("ops.backups.policies");
  const tc = useTranslations("common");
  const [kind, setKind] = useState<BackupKind>("cloud-snapshot");
  const [form, setForm] = useState({
    name: "",
    instanceId: instances[0]?.id ?? "",
    cronExpr: "0 3 * * *",
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 6,
    s3Uri: "",
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    awsRegion: "",
    paths: "/var/lib/docker/volumes /etc",
    localDir: "/var/backups",
    targetRegion: "",
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const create = useAction(
    async (): Promise<ActionResult> => {
      const pathsArr = form.paths.split(/\s+/).filter(Boolean);
      const r = await createBackupPolicyAction({
        name: form.name,
        kind,
        instanceId: form.instanceId,
        cronExpr: form.cronExpr,
        retention: { keepDaily: form.keepDaily, keepWeekly: form.keepWeekly, keepMonthly: form.keepMonthly },
        s3:
          kind === "s3-dump"
            ? {
                s3Uri: form.s3Uri,
                awsAccessKeyId: form.awsAccessKeyId,
                awsSecretAccessKey: form.awsSecretAccessKey,
                region: form.awsRegion || undefined,
                paths: pathsArr,
              }
            : undefined,
        local: kind === "local-copy" ? { dir: form.localDir, paths: pathsArr } : undefined,
        crossRegion: kind === "cross-region" ? { targetRegion: form.targetRegion } : undefined,
      });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("added"), refresh: false, onSuccess: onDone },
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void create.run();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("form.name")}>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("form.namePlaceholder")} required />
        </Field>
        <Field label={t("form.kind")}>
          <Select value={kind} onValueChange={(v) => setKind(v as BackupKind)}>
            <SelectTrigger aria-label={t("form.kind")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kinds.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("form.target")}>
          <Select value={form.instanceId} onValueChange={(v) => set("instanceId", v)}>
            <SelectTrigger aria-label={t("form.target")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name ?? i.providerInstanceId} ({i.provider})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("form.cron")}>
          <Input value={form.cronExpr} onChange={(e) => set("cronExpr", e.target.value)} className="font-mono" required />
        </Field>
        <Field label={t("form.retention")} hint={t("form.retentionHint")} className="sm:col-span-2">
          <div className="grid grid-cols-3 gap-2">
            <Input type="number" min={0} value={form.keepDaily} onChange={(e) => set("keepDaily", Number(e.target.value))} aria-label={t("form.keepDaily")} />
            <Input type="number" min={0} value={form.keepWeekly} onChange={(e) => set("keepWeekly", Number(e.target.value))} aria-label={t("form.keepWeekly")} />
            <Input type="number" min={0} value={form.keepMonthly} onChange={(e) => set("keepMonthly", Number(e.target.value))} aria-label={t("form.keepMonthly")} />
          </div>
        </Field>
      </div>

      {kind === "s3-dump" && (
        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <Field label={t("form.s3Uri")} className="sm:col-span-2">
            <Input value={form.s3Uri} onChange={(e) => set("s3Uri", e.target.value)} placeholder="s3://my-backups/prod/" className="font-mono" />
          </Field>
          <Field label={t("form.awsAccessKeyId")}>
            <Input value={form.awsAccessKeyId} onChange={(e) => set("awsAccessKeyId", e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t("form.awsSecretAccessKey")}>
            <Input type="password" value={form.awsSecretAccessKey} onChange={(e) => set("awsSecretAccessKey", e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t("form.awsRegion")}>
            <Input value={form.awsRegion} onChange={(e) => set("awsRegion", e.target.value)} />
          </Field>
          <Field label={t("form.paths")} hint={t("form.pathsHint")}>
            <Input value={form.paths} onChange={(e) => set("paths", e.target.value)} className="font-mono" />
          </Field>
        </div>
      )}
      {kind === "local-copy" && (
        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <Field label={t("form.localDir")}>
            <Input value={form.localDir} onChange={(e) => set("localDir", e.target.value)} className="font-mono" />
          </Field>
          <Field label={t("form.paths")} hint={t("form.pathsHint")}>
            <Input value={form.paths} onChange={(e) => set("paths", e.target.value)} className="font-mono" />
          </Field>
        </div>
      )}
      {kind === "cross-region" && (
        <div className="grid gap-3 border-t border-border pt-4">
          <Field label={t("form.targetRegion")}>
            <Input value={form.targetRegion} onChange={(e) => set("targetRegion", e.target.value)} placeholder="us-west-2" />
          </Field>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button type="submit" loading={create.pending} disabled={!form.name || !form.instanceId}>
          {t("add")}
        </Button>
      </div>
    </form>
  );
}
