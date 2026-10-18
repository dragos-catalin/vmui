"use client";

import { toError } from "@/components/settings/adapt";
import { Alert, Badge, Button, EmptyState, Field, Input, PageHeader, PageSection, PageShell, Progress, SkeletonList } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { listAccountRegionsForRestoreAction, listSuccessfulBackupJobsAction, restoreFromBackupAction } from "@/server/actions/restore";
import { Archive, CheckCircle2, Cloud, RotateCcw } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

interface Job {
  id: string;
  startedAt: Date;
  artifactRef: string | null;
  sizeBytes: number | null;
  policyName: string;
  kind: string | null;
  instanceId: string | null;
}

interface Account {
  id: string;
  name: string;
  provider: string;
  defaultRegion: string | null;
  regions: string[];
}

const SNAPSHOT_KINDS = new Set(["cloud-snapshot", "cross-region"]);

function formatBytes(n: number | null, format: ReturnType<typeof useFormatter>): string {
  if (n == null) return "—";
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return format.number(v, { style: "unit", unit: units[i] ?? "byte", maximumFractionDigits: 1 });
}

export function RestoreWizard() {
  const t = useTranslations("ops.restore");
  const format = useFormatter();
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState({
    backupJobId: "",
    accountId: "",
    region: "",
    name: "restored-vm",
    instanceType: "t3.small",
    template: "ubuntu-22.04",
  });
  const [launched, setLaunched] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [j, a] = await Promise.all([listSuccessfulBackupJobsAction(), listAccountRegionsForRestoreAction()]);
      setJobs(j as Job[]);
      setAccounts(a as Account[]);
    })();
  }, []);

  const job = useMemo(() => jobs?.find((x) => x.id === form.backupJobId), [jobs, form.backupJobId]);
  const acc = useMemo(() => accounts.find((a) => a.id === form.accountId), [accounts, form.accountId]);
  const isSnapshotKind = job ? SNAPSHOT_KINDS.has(job.kind ?? "") : false;

  const step1Done = form.backupJobId !== "";
  const step2Done = step1Done && form.accountId !== "" && form.region.trim() !== "";
  const step3Done = launched !== null;
  const progress = step3Done ? 3 : step2Done ? 2 : step1Done ? 1 : 0;

  const restore = useAction(
    async (): Promise<ActionResult<string>> => {
      const r = await restoreFromBackupAction(form);
      return r.ok ? ok(r.providerInstanceId) : toError(r);
    },
    { success: (id) => t("toast.launching", { id }), onSuccess: setLaunched },
  );

  const launch = async () => {
    const yes = await confirm({
      title: t("confirm.title", { name: form.name }),
      description: t("confirm.description", { account: acc?.name ?? "", region: form.region }),
      tone: "warning",
      confirmText: t("confirm.cta"),
      requireText: form.name,
    });
    if (yes) await restore.run();
  };

  return (
    <PageShell width="narrow">
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<RotateCcw />}
        badge={jobs ? <Badge variant="muted">{t("jobsCount", { count: jobs.length })}</Badge> : undefined}
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href="/backups">{t("openBackups")}</Link>
          </Button>
        }
      />

      <Progress value={progress} max={3} label={t("progress", { step: Math.min(progress + 1, 3), total: 3 })} tone={step3Done ? "success" : "default"} />

      <PageSection title={t("steps.backup.title")} description={t("steps.backup.description")} action={<StepBadge done={step1Done} />}>
        {jobs === null ? (
          <SkeletonList rows={3} />
        ) : jobs.length === 0 ? (
          <EmptyState
            compact
            icon={<Archive />}
            title={t("steps.backup.emptyTitle")}
            description={t("steps.backup.emptyDescription")}
            action={
              <Button size="sm" asChild>
                <Link href="/backups">{t("openBackups")}</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-2" role="radiogroup" aria-label={t("steps.backup.title")}>
            {jobs.slice(0, 50).map((j, i) => {
              const selected = j.id === form.backupJobId;
              return (
                <m.li key={j.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setForm({ ...form, backupJobId: j.id })}
                    className={cn(
                      "card-hover flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      selected ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_10%,transparent)]" : "border-border",
                    )}
                  >
                    <Archive className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{j.policyName}</span>
                        <Badge variant={SNAPSHOT_KINDS.has(j.kind ?? "") ? "success" : "warning"}>{j.kind ?? t("steps.backup.fileArchive")}</Badge>
                      </span>
                      <span className="block truncate font-mono text-xs text-fg-muted">{j.artifactRef ?? "?"}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-fg-muted">
                      <span className="block whitespace-nowrap">{format.dateTime(new Date(j.startedAt), { dateStyle: "medium", timeStyle: "short" })}</span>
                      <span className="block tabular-nums">{formatBytes(j.sizeBytes, format)}</span>
                    </span>
                  </button>
                </m.li>
              );
            })}
          </ul>
        )}
        {job && !isSnapshotKind && (
          <Alert tone="warning" className="mt-3" title={t("steps.backup.archiveTitle", { kind: job.kind ?? t("steps.backup.fileArchive") })}>
            {t("steps.backup.archiveHint")}
          </Alert>
        )}
      </PageSection>

      <PageSection title={t("steps.target.title")} description={t("steps.target.description")} action={<StepBadge done={step2Done} />}>
        <fieldset disabled={!step1Done} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
          <Field label={t("steps.target.account")}>
            <Select value={form.accountId} onValueChange={(v) => setForm({ ...form, accountId: v, region: accounts.find((a) => a.id === v)?.defaultRegion ?? "" })}>
              <SelectTrigger aria-label={t("steps.target.account")}>
                <SelectValue placeholder={t("steps.target.selectAccount")} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {a.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("steps.target.region")} hint={acc?.regions.length ? t("steps.target.regionHint", { regions: acc.regions.join(", ") }) : undefined}>
            <Input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} list="restore-regions" className="font-mono" />
            <datalist id="restore-regions">
              {(acc?.regions ?? []).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <Field label={t("steps.target.name")}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t("steps.target.instanceType")}>
            <Input value={form.instanceType} onChange={(e) => setForm({ ...form, instanceType: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t("steps.target.template")} hint={t("steps.target.templateHint")} className="sm:col-span-2">
            <Input value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} className="font-mono" />
          </Field>
        </fieldset>
      </PageSection>

      <PageSection title={t("steps.launch.title")} description={t("steps.launch.description")} action={<StepBadge done={step3Done} />}>
        {launched ? (
          <Alert tone="success" title={t("steps.launch.launchedTitle")} icon={<CheckCircle2 />}>
            <p>{t("steps.launch.launchedHint")}</p>
            <code className="mt-1 block break-all font-mono text-xs">{launched}</code>
          </Alert>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Summary label={t("steps.backup.title")} value={job ? `${job.policyName} · ${job.artifactRef ?? "?"}` : "—"} />
            <Summary label={t("steps.target.account")} value={acc ? `${acc.name} · ${acc.provider}` : "—"} icon={<Cloud className="size-3.5" aria-hidden />} />
            <Summary label={t("steps.target.region")} value={form.region || "—"} mono />
            <Summary label={t("steps.target.name")} value={`${form.name} · ${form.instanceType}`} mono />
          </dl>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {launched && (
            <Button variant="secondary" asChild>
              <Link href="/instances">{t("steps.launch.openInstances")}</Link>
            </Button>
          )}
          <Button onClick={() => void launch()} loading={restore.pending} disabled={!step2Done || !form.name.trim()}>
            <RotateCcw className="size-4" aria-hidden />
            {launched ? t("steps.launch.again") : t("steps.launch.cta")}
          </Button>
        </div>
      </PageSection>
    </PageShell>
  );
}

function StepBadge({ done }: { done: boolean }) {
  const t = useTranslations("ops.restore");
  return done ? (
    <Badge variant="success">
      <CheckCircle2 className="size-3" aria-hidden />
      {t("stepDone")}
    </Badge>
  ) : (
    <Badge variant="muted">{t("stepPending")}</Badge>
  );
}

function Summary({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-md)] border border-border px-3 py-2">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {icon}
        {label}
      </dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}
