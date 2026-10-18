"use client";

import { Badge, Button, DataTable, EmptyState, Field, Input, PageSection, Textarea, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ok } from "@/lib/action-result";
import type { BootScriptRow } from "@/lib/db/schema";
import { deleteBootScriptAction, upsertBootScriptAction } from "@/server/actions/boot-scripts";
import { Pencil, Plus, Save, ScrollText, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toResult } from "./adapt";
import { RelativeTime } from "./relative-time";

const KINDS = ["cloud-init", "bash", "powershell"] as const;
type Kind = (typeof KINDS)[number];

interface Draft {
  id?: string;
  name: string;
  description: string;
  kind: Kind;
  body: string;
}

function toDraft(row: BootScriptRow): Draft {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    kind: row.kind as Kind,
    body: row.body,
  };
}

export function BootScriptsCard({ initial }: { initial: BootScriptRow[] }) {
  const t = useTranslations("settings.automation.bootScripts");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [rows, setRows] = useState<BootScriptRow[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = useAction(
    async (d: Draft) => {
      const r = await upsertBootScriptAction({
        id: d.id,
        name: d.name,
        description: d.description || null,
        kind: d.kind,
        body: d.body,
      });
      if (!r.ok || !r.id) return toResult(r);
      const row: BootScriptRow = {
        id: r.id,
        name: d.name,
        description: d.description || null,
        kind: d.kind,
        body: d.body,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setRows((prev) => {
        const i = prev.findIndex((x) => x.id === row.id);
        if (i < 0) return [...prev, row];
        const copy = [...prev];
        copy[i] = { ...prev[i]!, ...row, createdAt: prev[i]!.createdAt };
        return copy;
      });
      return ok();
    },
    { success: t("saved"), refresh: false, onSuccess: () => setDraft(null) },
  );

  const remove = useAction(
    async (id: string) => {
      const r = toResult(await deleteBootScriptAction(id));
      if (r.ok) setRows((prev) => prev.filter((x) => x.id !== id));
      return r;
    },
    { success: t("deleted"), refresh: false },
  );

  async function onRemove(row: BootScriptRow) {
    const yes = await confirm({
      title: t("confirmDelete", { name: row.name }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(row.id);
  }

  const columns = useMemo<ColumnDef<BootScriptRow, unknown>[]>(
    () => [
      { accessorKey: "name", header: t("columns.name"), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      { accessorKey: "kind", header: t("columns.kind"), cell: ({ row }) => <Badge variant="info">{row.original.kind}</Badge> },
      {
        accessorKey: "description",
        header: t("columns.description"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="block max-w-[20rem] truncate text-fg-muted" title={row.original.description ?? undefined}>
            {row.original.description ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: t("columns.updated"),
        cell: ({ row }) => <RelativeTime date={row.original.updatedAt} className="whitespace-nowrap text-fg-muted" />,
      },
    ],
    [t],
  );

  const canSave = !!draft && draft.name.trim().length > 0 && draft.body.trim().length > 0;

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        <Button size="sm" onClick={() => setDraft({ name: "", description: "", kind: "cloud-init", body: "" })}>
          <Plus className="size-4" aria-hidden /> {t("add")}
        </Button>
      }
    >
      <DataTable
        columns={columns}
        data={rows}
        dense
        getRowId={(r) => r.id}
        emptyState={<EmptyState compact icon={<ScrollText />} title={t("empty")} description={t("emptyHint")} />}
        rowActions={(s) => (
          <>
            <Button size="icon" variant="ghost" onClick={() => setDraft(toDraft(s))} aria-label={t("edit")}>
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void onRemove(s)} disabled={remove.pending} aria-label={t("delete")}>
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </>
        )}
      />

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-2xl">
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
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field label={t("name")}>
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("namePlaceholder")} required />
                </Field>
                <Field label={t("kind")}>
                  <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as Kind })}>
                    <SelectTrigger aria-label={t("kind")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label={t("descriptionField")}>
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={t("descriptionPlaceholder")} />
              </Field>
              <Field label={t("body")}>
                <Textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={12}
                  placeholder={"#cloud-config\npackage_update: true"}
                  spellCheck={false}
                  className="font-mono text-xs"
                  required
                />
              </Field>
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
    </PageSection>
  );
}
