"use client";
import { Button, EmptyState, Field, Input, PageSection, Subsection, Textarea } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import type { InstanceRunbookRow } from "@/lib/db/schema";
import { deleteRunbookAction, upsertRunbookAction } from "@/server/actions/extras";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

export function RunbookEditorClient({
  accountId,
  providerInstanceId,
  initial,
}: {
  accountId: string;
  providerInstanceId: string;
  initial: InstanceRunbookRow[];
}) {
  const t = useTranslations("vm.runbooks");
  const tc = useTranslations("common");
  const format = useFormatter();
  const confirm = useConfirm();
  const [rows, setRows] = useState(initial);
  const [editing, setEditing] = useState<InstanceRunbookRow | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const { run: runSave, pending: saving } = useAction(upsertRunbookAction, { success: t("saved"), refresh: false });
  const { run: runDelete, pending: deleting } = useAction(deleteRunbookAction, { success: t("deleted"), refresh: false });
  const pending = saving || deleting;

  function startNew() {
    setEditing({ id: "", accountId, providerInstanceId, title: "", body: "", createdAt: new Date(), updatedAt: new Date(), createdBy: null });
    setTitle("");
    setBody("");
  }
  function startEdit(r: InstanceRunbookRow) {
    setEditing(r);
    setTitle(r.title);
    setBody(r.body);
  }
  function cancel() { setEditing(null); }

  async function save() {
    const id = editing?.id || undefined;
    const r = await runSave({ id, accountId, providerInstanceId, title, body });
    if (!r.ok) return;
    setEditing(null);
    const newRow: InstanceRunbookRow = {
      id: id ?? crypto.randomUUID(),
      accountId, providerInstanceId, title, body,
      createdAt: editing?.createdAt ?? new Date(), updatedAt: new Date(), createdBy: editing?.createdBy ?? null,
    };
    setRows((prev) => id ? prev.map((x) => x.id === id ? newRow : x) : [newRow, ...prev]);
  }
  async function remove(row: InstanceRunbookRow) {
    const ok = await confirm({
      title: t("deleteTitle", { title: row.title }),
      description: t("deleteBody"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (!ok) return;
    const r = await runDelete(row.id);
    if (r.ok) setRows((prev) => prev.filter((x) => x.id !== row.id));
  }

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        !editing && (
          <Button size="sm" onClick={startNew}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("new")}
          </Button>
        )
      }
    >
      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {editing && (
            <m.form
              key="editor"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2 }}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Subsection title={editing.id ? tc("edit") : t("new")}>
                <Field label={t("titleLabel")}>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t("titlePlaceholder")}
                    maxLength={200}
                    disabled={saving}
                  />
                </Field>
                <Field label={t("bodyLabel")}>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={t("bodyPlaceholder")}
                    rows={8}
                    className="font-mono"
                    disabled={saving}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={saving}>
                    {tc("cancel")}
                  </Button>
                  <Button type="submit" size="sm" disabled={!title.trim() || !body.trim()} loading={saving}>
                    {tc("save")}
                  </Button>
                </div>
              </Subsection>
            </m.form>
          )}
        </AnimatePresence>

        {rows.length === 0 && !editing ? (
          <EmptyState
            compact
            icon={<BookOpen />}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            action={
              <Button size="sm" variant="secondary" onClick={startNew}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t("new")}
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <m.div
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                >
                  <Subsection
                    collapsible
                    defaultOpen={false}
                    title={r.title}
                    hint={t("updated", { date: format.dateTime(r.updatedAt, { dateStyle: "medium" }) })}
                  >
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">{r.body}</pre>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(r)} disabled={pending}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        {tc("edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:text-danger"
                        onClick={() => void remove(r)}
                        disabled={pending}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        {tc("delete")}
                      </Button>
                    </div>
                  </Subsection>
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </PageSection>
  );
}
