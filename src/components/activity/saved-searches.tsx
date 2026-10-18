"use client";

import { Badge, Button, Checkbox, EmptyState, Field, Input, PageSection } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import { createSavedSearchAction, deleteSavedSearchAction } from "@/server/actions/extras";
import { Bookmark, Pin, Plus, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";

export interface SavedSearchItem {
  id: string;
  name: string;
  query: string;
  pinned: boolean;
}

const wrap =
  <A extends unknown[]>(fn: (...a: A) => Promise<{ ok: boolean }>) =>
  async (...a: A): Promise<ActionResult> => {
    try {
      const r = await fn(...a);
      return r.ok ? { ok: true } : { ok: false, error: "common.error" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "common.error" };
    }
  };

export function SavedSearches({ items }: { items: SavedSearchItem[] }) {
  const t = useTranslations("observe.savedSearches");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [name, setName] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [pinned, setPinned] = React.useState(false);

  const create = useAction(wrap(createSavedSearchAction), {
    success: t("saved"),
    onSuccess: () => {
      setName("");
      setQuery("");
      setPinned(false);
    },
  });
  const remove = useAction(wrap(deleteSavedSearchAction), { success: t("deleted") });

  return (
    <div className="space-y-4">
      <PageSection title={t("form.title")} description={t("form.description")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create.run({ name, query: query.replace(/^\?/, ""), pinned });
          }}
          className="space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("form.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={t("form.namePlaceholder")} />
            </Field>
            <Field label={t("form.query")} className="sm:col-span-2" hint={t("form.queryHint")}>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} required maxLength={2000} placeholder="provider=aws&state=running" className="font-mono text-xs" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <Checkbox checked={pinned} onCheckedChange={setPinned} />
              {t("form.pinned")}
            </label>
            <Button type="submit" loading={create.pending}>
              <Plus className="size-4" aria-hidden /> {tc("save")}
            </Button>
          </div>
        </form>
      </PageSection>

      <PageSection title={t("listTitle")} description={t("count", { count: items.length })}>
        {items.length === 0 ? (
          <EmptyState compact icon={<Bookmark />} title={t("empty.title")} description={t("empty.description")} />
        ) : (
          <ul className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {items.map((s, i) => (
                <m.li
                  key={s.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 24 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                  className="flex items-center gap-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {s.pinned && (
                        <Badge variant="info">
                          <Pin className="size-3" aria-hidden /> {t("pinned")}
                        </Badge>
                      )}
                      <span className="min-w-0 truncate">{s.name}</span>
                    </div>
                    <Link href={`/instances?${s.query}`} className="block truncate font-mono text-xs text-primary hover:underline">
                      /instances?{s.query}
                    </Link>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tc("delete")}
                    className="text-danger"
                    onClick={async () => {
                      if (!(await confirm({ title: t("confirmDelete", { name: s.name }), tone: "danger", confirmText: tc("delete") }))) return;
                      void remove.run(s.id);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </PageSection>
    </div>
  );
}
