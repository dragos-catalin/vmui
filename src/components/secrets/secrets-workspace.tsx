"use client";

import { Alert, Badge, Button, Checkbox, DataTable, EmptyState, Field, Input, PageSection, Progress, sortableHeader, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { useInterval } from "@/hooks/use-poll";
import { ok, type ActionResult } from "@/lib/action-result";
import {
    createSecretAction,
    deleteSecretAction,
    exportSealedSecretAction,
    listSecretsAction,
    pushSecretToInstanceAction,
    revealSecretAction,
    rotateSecretAction,
} from "@/server/actions/secrets";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Database, Download, Eye, KeyRound, Lock, Plus, RotateCw, Send, Sparkles, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import * as React from "react";

type Kind = "db" | "api-key" | "password" | "generic";

interface SecretRow {
  id: string;
  name: string;
  kind: Kind;
  rotationDays: number | null;
  lastRotatedAt: Date | null;
  sealed: boolean;
  createdAt: Date;
}

export interface InstanceLite {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
}

const KIND_ICON: Record<Kind, typeof KeyRound> = { db: Database, "api-key": KeyRound, password: Lock, generic: Sparkles };
const KINDS: readonly Kind[] = ["generic", "db", "api-key", "password"];
const REVEAL_SECONDS = 30;
const QUERY_KEY = ["secrets"] as const;

export function SecretsWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("govern.secrets");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = React.useState(false);
  const [pushFor, setPushFor] = React.useState<SecretRow | null>(null);
  const [exportFor, setExportFor] = React.useState<SecretRow | null>(null);
  const [revealed, setRevealed] = React.useState<{ id: string; name: string; value: string; at: number } | null>(null);

  const { data: rows = [], isPending } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await listSecretsAction()) as SecretRow[],
    refetchInterval: 15_000,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const reveal = useAction(
    async (row: SecretRow): Promise<ActionResult<string>> => {
      const r = await revealSecretAction(row.id);
      return r.ok ? ok(r.value) : { ok: false, error: r.error };
    },
    { refresh: false },
  );
  const rotate = useAction(
    async (row: SecretRow): Promise<ActionResult<string>> => {
      const r = await rotateSecretAction(row.id);
      return r.ok ? ok(r.value) : { ok: false, error: r.error };
    },
    { success: t("toast.rotated"), invalidate: [QUERY_KEY] },
  );
  const remove = useAction(
    async (row: SecretRow): Promise<ActionResult> => {
      await deleteSecretAction(row.id);
      return ok();
    },
    { success: t("toast.deleted"), invalidate: [QUERY_KEY] },
  );

  async function onReveal(row: SecretRow) {
    const r = await reveal.run(row);
    if (r.ok) setRevealed({ id: row.id, name: row.name, value: r.data, at: Date.now() });
  }
  async function onRotate(row: SecretRow) {
    const yes = await confirm({ title: t("confirm.rotate.title", { name: row.name }), description: t("confirm.rotate.description"), tone: "warning", confirmText: t("confirm.rotate.confirm") });
    if (!yes) return;
    const r = await rotate.run(row);
    if (r.ok) setRevealed({ id: row.id, name: row.name, value: r.data, at: Date.now() });
  }
  async function onDelete(row: SecretRow) {
    const yes = await confirm({ title: t("confirm.delete.title", { name: row.name }), description: t("confirm.delete.description"), tone: "danger", confirmText: t("confirm.delete.confirm"), requireText: row.name });
    if (yes) await remove.run(row);
  }

  const columns = React.useMemo<ColumnDef<SecretRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: sortableHeader(t("columns.name")),
        cell: ({ row }) => {
          const Icon = KIND_ICON[row.original.kind];
          return (
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <code className="truncate font-mono text-xs font-medium">{row.original.name}</code>
            </span>
          );
        },
      },
      {
        accessorKey: "kind",
        header: sortableHeader(t("columns.scope")),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="muted">{t(`kinds.${row.original.kind}`)}</Badge>
            {row.original.sealed && <Badge variant="info">{t("sealed")}</Badge>}
          </span>
        ),
      },
      {
        accessorKey: "rotationDays",
        header: sortableHeader(t("columns.rotation")),
        cell: ({ row }) => <span className="text-fg-muted">{row.original.rotationDays ? t("rotationDays", { n: row.original.rotationDays }) : t("noRotation")}</span>,
      },
      {
        accessorKey: "lastRotatedAt",
        header: sortableHeader(t("columns.lastRotated")),
        cell: ({ row }) => {
          const d = row.original.lastRotatedAt;
          if (!d) return <span className="text-fg-muted">{t("never")}</span>;
          const date = new Date(d);
          return (
            <time dateTime={date.toISOString()} title={format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })} className="whitespace-nowrap text-fg-muted">
              {format.relativeTime(date, now)}
            </time>
          );
        },
      },
    ],
    [t, format, now],
  );

  return (
    <div className="space-y-4">
      {revealed && <RevealedAlert name={revealed.name} value={revealed.value} startedAt={revealed.at} onDismiss={() => setRevealed(null)} />}

      <PageSection
        title={t("title")}
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-4" aria-hidden /> {t("add")}
          </Button>
        }
      >
        <DataTable
          columns={columns}
          data={rows}
          loading={isPending}
          searchable={rows.length > 5}
          getRowId={(r) => r.id}
          emptyState={
            <EmptyState
              compact
              icon={<Lock />}
              title={t("empty.title")}
              description={t("empty.description")}
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="size-4" aria-hidden /> {t("add")}
                </Button>
              }
            />
          }
          rowActions={(row) => (
            <>
              <Button size="icon" variant="ghost" aria-label={t("actions.reveal")} title={t("actions.reveal")} onClick={() => void onReveal(row)} disabled={reveal.pending}>
                <Eye className="size-4" aria-hidden />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("actions.rotate")} title={t("actions.rotate")} onClick={() => void onRotate(row)} disabled={rotate.pending}>
                <RotateCw className="size-4" aria-hidden />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("actions.push")} title={t("actions.push")} onClick={() => setPushFor(row)}>
                <Send className="size-4" aria-hidden />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("actions.export")} title={t("actions.export")} onClick={() => setExportFor(row)}>
                <Download className="size-4" aria-hidden />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("actions.delete")} title={t("actions.delete")} onClick={() => void onDelete(row)} disabled={remove.pending}>
                <Trash2 className="size-4 text-danger" aria-hidden />
              </Button>
            </>
          )}
        />
      </PageSection>

      <CreateSecretDialog open={showCreate} onOpenChange={setShowCreate} onCreated={invalidate} />
      <PushDialog row={pushFor} instances={instances} onOpenChange={(o) => !o && setPushFor(null)} />
      <ExportDialog row={exportFor} onOpenChange={(o) => !o && setExportFor(null)} />
    </div>
  );
}

function RevealedAlert({ name, value, startedAt, onDismiss }: { name: string; value: string; startedAt: number; onDismiss: () => void }) {
  const t = useTranslations("govern.secrets");
  const [left, setLeft] = React.useState(REVEAL_SECONDS);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => setLeft(REVEAL_SECONDS), [startedAt]);
  // Keeps ticking in a hidden tab so a revealed secret never outlives its window.
  useInterval(
    () => {
      const remaining = Math.max(0, REVEAL_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(remaining);
      if (remaining === 0) onDismiss();
    },
    250,
    { pauseHidden: false },
  );

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Alert
      tone="success"
      title={t("revealed.title", { name })}
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("revealed.dismiss")}
        </Button>
      }
    >
      <p>{t("revealed.hint")}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 font-mono text-xs text-fg">{value}</code>
        <Button size="icon" variant="outline" onClick={() => void copy()} aria-label={t("revealed.copy")}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </Button>
      </div>
      <Progress className="mt-3" size="sm" tone="success" value={left} max={REVEAL_SECONDS} label={t("revealed.countdown", { seconds: left })} />
    </Alert>
  );
}

function CreateSecretDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const t = useTranslations("govern.secrets");
  const tc = useTranslations("common");
  const [form, setForm] = React.useState({ name: "", kind: "generic" as Kind, value: "", rotationDays: 90, sealed: false });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const create = useAction(
    async (): Promise<ActionResult> => {
      const r = await createSecretAction({ name: form.name.trim(), kind: form.kind, value: form.value, rotationDays: form.rotationDays || undefined, sealed: form.sealed });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    {
      success: t("toast.created"),
      onSuccess: () => {
        setForm({ name: "", kind: "generic", value: "", rotationDays: 90, sealed: false });
        onOpenChange(false);
        onCreated();
      },
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim() && form.value) void create.run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("create.title")}</DialogTitle>
            <DialogDescription>{t("create.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("create.name")} hint={t("create.nameHint")}>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("create.namePlaceholder")} className="font-mono" autoComplete="off" required />
            </Field>
            <Field label={t("create.kind")}>
              <Select value={form.kind} onValueChange={(v) => set("kind", v as Kind)}>
                <SelectTrigger aria-label={t("create.kind")}>
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
            <Field label={t("create.value")} className="sm:col-span-2">
              <Input type="password" value={form.value} onChange={(e) => set("value", e.target.value)} className="font-mono" autoComplete="new-password" required />
            </Field>
            <Field label={t("create.rotation")} hint={t("create.rotationHint")}>
              <Input type="number" min={0} max={3650} value={form.rotationDays} onChange={(e) => set("rotationDays", Number(e.target.value) || 0)} className="tabular-nums" />
            </Field>
            <Field label={t("create.sealed")} hint={t("create.sealedHint")} inline className="self-end">
              <Checkbox checked={form.sealed} onCheckedChange={(v) => set("sealed", v)} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" loading={create.pending} disabled={!form.name.trim() || !form.value}>
              {t("create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PushDialog({ row, instances, onOpenChange }: { row: SecretRow | null; instances: InstanceLite[]; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("govern.secrets");
  const tc = useTranslations("common");
  const [instanceId, setInstanceId] = React.useState(instances[0]?.id ?? "");
  const [envPath, setEnvPath] = React.useState("/etc/vmui/secrets.env");

  const push = useAction(
    async (): Promise<ActionResult> => {
      if (!row) return { ok: false, error: "common.error" };
      const r = await pushSecretToInstanceAction(row.id, instanceId, envPath);
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("toast.pushed"), refresh: false, onSuccess: () => onOpenChange(false) },
  );

  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (instanceId) void push.run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("push.title", { name: row?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("push.description")}</DialogDescription>
          </DialogHeader>
          {instances.length === 0 ? (
            <Alert tone="warning">{t("push.none")}</Alert>
          ) : (
            <div className="grid gap-3">
              <Field label={t("push.instance")}>
                <Select value={instanceId} onValueChange={setInstanceId}>
                  <SelectTrigger aria-label={t("push.instance")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name ?? i.providerInstanceId} · {i.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("push.path")}>
                <Input value={envPath} onChange={(e) => setEnvPath(e.target.value)} className="font-mono" />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" loading={push.pending} disabled={!instanceId || instances.length === 0}>
              <Send className="size-4" aria-hidden /> {t("push.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({ row, onOpenChange }: { row: SecretRow | null; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("govern.secrets");
  const tc = useTranslations("common");
  const [pass, setPass] = React.useState("");

  const exportSealed = useAction(
    async (): Promise<ActionResult> => {
      if (!row) return { ok: false, error: "common.error" };
      const r = await exportSealedSecretAction(row.id, pass);
      if (!r.ok) return { ok: false, error: r.error };
      const blob = new Blob([r.body], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      return ok();
    },
    {
      success: t("toast.exported"),
      refresh: false,
      onSuccess: () => {
        setPass("");
        onOpenChange(false);
      },
    },
  );

  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (pass.length >= 8) void exportSealed.run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("export.title", { name: row?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("export.description")}</DialogDescription>
          </DialogHeader>
          <Field label={t("export.passphrase")} hint={t("export.passphraseHint")}>
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} minLength={8} autoComplete="new-password" required />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" loading={exportSealed.pending} disabled={pass.length < 8}>
              <Download className="size-4" aria-hidden /> {t("export.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
