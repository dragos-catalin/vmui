"use client";
import { Button, EmptyState, Field, Input, PageSection } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import type { InstanceSecretRow } from "@/lib/db/schema";
import { deleteInstanceSecretAction, setInstanceSecretAction } from "@/server/actions/extras-2";
import { KeyRound, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

type Row = Pick<InstanceSecretRow, "id" | "key" | "updatedAt">;

export function SecretsVaultClient({
  accountId,
  providerInstanceId,
  initial,
}: {
  accountId: string;
  providerInstanceId: string;
  initial: Row[];
}) {
  const t = useTranslations("vm.secrets");
  const tc = useTranslations("common");
  const format = useFormatter();
  const confirm = useConfirm();
  const [rows, setRows] = useState(initial);
  const [k, setK] = useState("");
  const [v, setV] = useState("");

  const { run: runSet, pending: saving } = useAction(setInstanceSecretAction, { success: t("saved"), refresh: false });
  const { run: runDelete, pending: deleting } = useAction(deleteInstanceSecretAction, { success: t("deleted"), refresh: false });

  async function add() {
    const key = k.trim();
    if (!key) return;
    const r = await runSet({ accountId, providerInstanceId, key, value: v });
    if (!r.ok) return;
    setRows((prev) => prev.find((x) => x.key === key)
      ? prev.map((x) => x.key === key ? { ...x, updatedAt: new Date() } : x)
      : [{ id: crypto.randomUUID(), key, updatedAt: new Date() }, ...prev]);
    setK("");
    setV("");
  }
  async function remove(row: Row) {
    const ok = await confirm({
      title: t("deleteTitle", { key: row.key }),
      description: t("deleteBody"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (!ok) return;
    const r = await runDelete(row.id);
    if (r.ok) setRows((prev) => prev.filter((x) => x.id !== row.id));
  }

  return (
    <PageSection title={t("title")} description={t("description")}>
      <div className="space-y-4">
        <form
          className="space-y-3"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("keyLabel")} hint={t("keyHint")}>
              <Input
                value={k}
                onChange={(e) => setK(e.target.value.toUpperCase())}
                placeholder={t("keyPlaceholder")}
                className="font-mono"
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
            </Field>
            <Field label={t("valueLabel")} className="sm:col-span-2">
              <Input
                value={v}
                onChange={(e) => setV(e.target.value)}
                type="password"
                placeholder={t("valuePlaceholder")}
                maxLength={8192}
                autoComplete="new-password"
                disabled={saving}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!k.trim()} loading={saving}>
              {t("save")}
            </Button>
          </div>
        </form>

        {rows.length === 0 ? (
          <EmptyState compact icon={<KeyRound />} title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border text-xs">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <m.li
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono">{r.key}</span>
                  <span className="hidden text-muted sm:inline">
                    {t("updated", { date: format.dateTime(r.updatedAt, { dateStyle: "medium" }) })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted hover:text-danger"
                    onClick={() => void remove(r)}
                    disabled={deleting}
                    aria-label={t("deleteAria", { key: r.key })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </PageSection>
  );
}
