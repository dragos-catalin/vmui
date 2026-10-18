"use client";

import { Badge, Button, DataTable, EmptyState, Field, Input, PageSection, SkeletonText, Switch, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import type { WebhookRow } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import {
    deleteWebhookAction,
    recentWebhookDeliveriesAction,
    testWebhookAction,
    upsertWebhookAction,
    type WebhookDelivery,
} from "@/server/actions/webhooks";
import { History as HistoryIcon, Pencil, Plus, Save, Trash2, Webhook, Zap } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toError, toResult } from "./adapt";

const ALL_CHANNELS = [
  "instance.changed",
  "sync.completed",
  "snapshot.created",
  "notification.created",
] as const;
type Channel = (typeof ALL_CHANNELS)[number];
const KINDS = ["slack", "discord", "generic"] as const;
type Kind = (typeof KINDS)[number];

interface Draft {
  id?: string;
  name: string;
  url: string;
  kind: Kind;
  channels: Channel[];
  enabled: boolean;
  cooldownSec: number | null;
}

function parseChannels(json: string): Channel[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (Array.isArray(arr)) return arr.filter((s): s is Channel => ALL_CHANNELS.includes(s as Channel));
  } catch {
    // ignore
  }
  return [];
}

function toDraft(row: WebhookRow): Draft {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind as Kind,
    channels: parseChannels(row.channels),
    enabled: row.enabled === 1,
    cooldownSec: row.cooldownSec ?? null,
  };
}

export function WebhooksCard({ initial }: { initial: WebhookRow[] }) {
  const t = useTranslations("settings.automation.webhooks");
  const tc = useTranslations("common");
  const format = useFormatter();
  const confirm = useConfirm();
  const [rows, setRows] = useState<WebhookRow[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<WebhookRow | null>(null);
  const [history, setHistory] = useState<WebhookDelivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function openHistory(row: WebhookRow) {
    setHistoryFor(row);
    setHistoryLoading(true);
    try {
      setHistory(await recentWebhookDeliveriesAction(row.id, 10));
    } finally {
      setHistoryLoading(false);
    }
  }

  const save = useAction(
    async (d: Draft) => {
      const r = await upsertWebhookAction(d);
      if (!r.ok || !r.id) return toResult(r);
      const id = r.id;
      setRows((prev) => {
        const i = prev.findIndex((p) => p.id === id);
        const base: WebhookRow = {
          id,
          name: d.name,
          url: d.url,
          kind: d.kind,
          channels: JSON.stringify(d.channels),
          enabled: d.enabled ? 1 : 0,
          cooldownSec: d.cooldownSec ?? null,
          createdAt: prev[i]?.createdAt ?? new Date(),
          lastFiredAt: prev[i]?.lastFiredAt ?? null,
          lastStatus: prev[i]?.lastStatus ?? null,
        };
        if (i < 0) return [...prev, base];
        const copy = prev.slice();
        copy[i] = base;
        return copy;
      });
      return ok();
    },
    { success: t("saved"), refresh: false, onSuccess: () => setDraft(null) },
  );

  const remove = useAction(
    async (id: string) => {
      await deleteWebhookAction(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
      return ok();
    },
    { success: t("deleted"), refresh: false },
  );

  async function onRemove(row: WebhookRow) {
    const yes = await confirm({
      title: t("confirmDelete", { name: row.name }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(row.id);
  }

  const test = useAction(
    async (id: string): Promise<ActionResult<string>> => {
      setTestingId(id);
      const r = await testWebhookAction({ id });
      setTestingId(null);
      return r.ok ? ok(r.status ?? "200") : toError(r);
    },
    { success: (status) => t("testSent", { status }), error: t("testFailed"), refresh: false },
  );

  function toggleChannel(c: Channel) {
    if (!draft) return;
    const next = draft.channels.includes(c)
      ? draft.channels.filter((x) => x !== c)
      : [...draft.channels, c];
    setDraft({ ...draft, channels: next });
  }

  const columns = useMemo<ColumnDef<WebhookRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium" title={row.original.name}>{row.original.name}</span>
            {row.original.enabled === 0 && <Badge variant="muted">{t("disabledBadge")}</Badge>}
          </span>
        ),
      },
      { accessorKey: "kind", header: t("columns.kind"), cell: ({ row }) => <Badge variant="info">{row.original.kind}</Badge> },
      {
        accessorKey: "url",
        header: t("columns.url"),
        enableSorting: false,
        cell: ({ row }) => (
          <code className="block max-w-[16rem] truncate font-mono text-xs text-fg-muted" title={row.original.url}>
            {row.original.url}
          </code>
        ),
      },
      {
        id: "channels",
        accessorFn: (r) => parseChannels(r.channels).join(" "),
        header: t("columns.channels"),
        enableSorting: false,
        cell: ({ row }) => {
          const list = parseChannels(row.original.channels).join(", ");
          return (
            <span className="block max-w-[16rem] truncate text-xs text-fg-muted" title={list || undefined}>
              {list || "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "lastStatus",
        header: t("columns.lastStatus"),
        cell: ({ row }) =>
          row.original.lastStatus ? (
            <span className={cn("text-xs", row.original.lastStatus === "ok" ? "text-success" : "text-danger")}>{row.original.lastStatus}</span>
          ) : (
            <span className="text-xs text-fg-muted">{t("never")}</span>
          ),
      },
    ],
    [t],
  );

  const canSave = !!draft && draft.name.trim().length > 0 && draft.url.trim().length > 0;

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        <Button
          size="sm"
          onClick={() => setDraft({ name: "", url: "", kind: "slack", channels: ["instance.changed"], enabled: true, cooldownSec: null })}
        >
          <Plus className="size-4" aria-hidden /> {t("add")}
        </Button>
      }
    >
      <DataTable
        columns={columns}
        data={rows}
        dense
        getRowId={(r) => r.id}
        emptyState={<EmptyState compact icon={<Webhook />} title={t("empty")} description={t("emptyHint")} />}
        rowActions={(row) => (
          <>
            <Button size="icon" variant="ghost" onClick={() => void openHistory(row)} aria-label={t("log")}>
              <HistoryIcon className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void test.run(row.id)}
              loading={test.pending && testingId === row.id}
              disabled={row.enabled === 0}
              aria-label={t("test")}
            >
              <Zap className="size-4" aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setDraft(toDraft(row))} aria-label={t("edit")}>
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void onRemove(row)} disabled={remove.pending} aria-label={t("delete")}>
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </>
        )}
      />

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-xl">
          {draft && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) void save.run(draft);
              }}
            >
              <DialogHeader>
                <DialogTitle>{draft.id ? t("editTitle") : t("newTitle")}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("name")}>
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("namePlaceholder")} maxLength={80} required />
                </Field>
                <Field label={t("kind")}>
                  <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as Kind })}>
                    <SelectTrigger aria-label={t("kind")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`kind${k.charAt(0).toUpperCase()}${k.slice(1)}` as "kindSlack" | "kindDiscord" | "kindGeneric")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label={t("url")}>
                <Input
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder="https://hooks.slack.com/…"
                  type="url"
                  className="font-mono text-xs"
                  required
                />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-xs text-fg-muted">{t("channels")}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_CHANNELS.map((c) => {
                    const on = draft.channels.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggleChannel(c)}
                        aria-pressed={on}
                        className={cn(
                          "min-h-10 rounded-full border px-3 font-mono text-2xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                          on
                            ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_15%,transparent)] text-primary"
                            : "border-border text-fg-muted hover:text-fg",
                        )}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field inline label={t("enabled")}>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
                </Field>
                <Field label={t("cooldown")} hint={t("cooldownHint")}>
                  <Input
                    type="number"
                    min={0}
                    max={86400}
                    step={1}
                    value={draft.cooldownSec ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const n = v === "" ? null : Number.parseInt(v, 10);
                      setDraft({ ...draft, cooldownSec: n !== null && Number.isFinite(n) ? n : null });
                    }}
                    placeholder="0"
                    className="font-mono tabular-nums"
                  />
                </Field>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={save.pending}>
                  {tc("cancel")}
                </Button>
                <Button type="submit" loading={save.pending} disabled={!canSave}>
                  <Save className="size-4" aria-hidden /> {tc("save")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={historyFor !== null} onOpenChange={(o) => !o && setHistoryFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("logTitle", { name: historyFor?.name ?? "" })}</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <SkeletonText lines={4} />
          ) : history.length === 0 ? (
            <EmptyState compact icon={<HistoryIcon />} title={t("logEmpty")} />
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto text-xs">
              {history.map((h) => (
                <li key={h.id} className="flex items-baseline gap-2 rounded-[var(--radius-sm)] bg-bg-muted px-2 py-1 font-mono">
                  <span className={cn("shrink-0", h.status === "ok" ? "text-success" : "text-danger")}>{h.status}</span>
                  <span className="shrink-0 text-fg-muted">{format.dateTime(new Date(h.createdAt), { dateStyle: "short", timeStyle: "short" })}</span>
                  <span className="min-w-0 truncate" title={h.message ?? undefined}>{h.message ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
