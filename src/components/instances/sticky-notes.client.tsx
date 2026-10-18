"use client";
import { Button, EmptyState, Field, PageSection, Textarea } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { deleteStickyNoteAction, upsertStickyNoteAction } from "@/server/actions/sticky-and-tags";
import { StickyNote, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

type Color = "amber" | "rose" | "emerald" | "sky" | "violet";
const COLORS: readonly Color[] = ["amber", "rose", "emerald", "sky", "violet"];
// Stored ids stay as-is so existing rows keep rendering; only the paint maps to tokens.
const COLOR_BG: Record<Color, string> = {
  amber: "bg-[color-mix(in_oklch,var(--color-warning)_22%,transparent)] border-[color-mix(in_oklch,var(--color-warning)_45%,var(--color-border))]",
  rose: "bg-[color-mix(in_oklch,var(--color-danger)_22%,transparent)] border-[color-mix(in_oklch,var(--color-danger)_45%,var(--color-border))]",
  emerald: "bg-[color-mix(in_oklch,var(--color-success)_22%,transparent)] border-[color-mix(in_oklch,var(--color-success)_45%,var(--color-border))]",
  sky: "bg-[color-mix(in_oklch,var(--color-info)_22%,transparent)] border-[color-mix(in_oklch,var(--color-info)_45%,var(--color-border))]",
  violet: "bg-[color-mix(in_oklch,var(--color-accent)_22%,transparent)] border-[color-mix(in_oklch,var(--color-accent)_45%,var(--color-border))]",
};
const COLOR_SWATCH: Record<Color, string> = {
  amber: "bg-warning",
  rose: "bg-danger",
  emerald: "bg-success",
  sky: "bg-info",
  violet: "bg-accent",
};
const isColor = (c: string): c is Color => (COLORS as readonly string[]).includes(c);

interface Note { id: string; body: string; color: string; createdAt: string; createdBy: string | null }
interface Props { accountId: string; providerInstanceId: string; notes: Note[] }

export function StickyNotesClient({ accountId, providerInstanceId, notes }: Props) {
  const t = useTranslations("vm.notesCard");
  const format = useFormatter();
  const [draft, setDraft] = useState("");
  const [color, setColor] = useState<Color>("amber");

  const { run: runAdd, pending: adding } = useAction(
    (body: string, c: Color) => upsertStickyNoteAction({ accountId, providerInstanceId, body, color: c }),
    { success: t("added") },
  );
  const { run: runDelete, pending: deleting } = useAction(deleteStickyNoteAction, { success: t("deleted") });

  async function add() {
    const body = draft.trim();
    if (!body) return;
    const r = await runAdd(body, color);
    if (r.ok) setDraft("");
  }

  return (
    <PageSection
      title={t("title")}
      action={<span className="text-xs text-muted">{t("count", { count: notes.length })}</span>}
    >
      <div className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Field label={t("body")}>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("placeholder")}
              rows={2}
              maxLength={2000}
              disabled={adding}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="radiogroup" aria-label={t("color")} className="flex items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t(`colors.${c}`)}
                  title={t(`colors.${c}`)}
                  onClick={() => setColor(c)}
                  className={cn(
                    "grid size-10 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:size-9",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "block size-5 rounded-full transition-transform",
                      COLOR_SWATCH[c],
                      color === c ? "scale-110 ring-2 ring-fg ring-offset-2 ring-offset-surface" : "opacity-70",
                    )}
                  />
                </button>
              ))}
            </div>
            <Button type="submit" size="sm" disabled={!draft.trim()} loading={adding}>
              {t("add")}
            </Button>
          </div>
        </form>

        {notes.length === 0 ? (
          <EmptyState compact icon={<StickyNote />} title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>
              {notes.map((n, i) => {
                const c: Color = isColor(n.color) ? n.color : "amber";
                return (
                  <m.div
                    key={n.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                    className={cn("relative rounded-[var(--radius-lg)] border p-3 text-sm text-fg", COLOR_BG[c])}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1 h-8 w-8 text-muted hover:text-fg sm:h-7 sm:w-7"
                      onClick={() => void runDelete(n.id)}
                      disabled={deleting}
                      aria-label={t("deleteNote")}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <div className="whitespace-pre-wrap break-words pr-7">{n.body}</div>
                    <div className="mt-2 text-[10px] text-muted">
                      {format.dateTime(new Date(n.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                    </div>
                  </m.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </PageSection>
  );
}
