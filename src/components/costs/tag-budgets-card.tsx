"use client";

import { toResult } from "@/components/settings/adapt";
import { Button, Input, Label, PageSection, Progress } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import { HOURS_PER_MONTH } from "@/lib/utils";
import {
    deleteTagBudgetAction,
    evaluateTagBudgetsAction,
    listTagBudgetsAction,
    upsertTagBudgetAction,
    type TagBudgetEvalResult,
} from "@/server/actions/tag-budgets";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { useMoney } from "./use-money";

interface BudgetRow {
  id: string;
  tagKey: string;
  tagValue: string | null;
  monthlyUsd: number;
  lastObservedUsd: number | null;
  exceeded: number;
}

interface DraftRow {
  id?: string;
  tagKey: string;
  tagValue: string;
  monthlyUsd: string;
}

export function TagBudgetsCard() {
  const t = useTranslations("cloud.costs.budgets");
  const tCommon = useTranslations("common");
  const { usd } = useMoney();
  const formId = useId();
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [evalResults, setEvalResults] = useState<Map<string, TagBudgetEvalResult>>(new Map());
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [evaluating, startEval] = useTransition();

  async function refresh() {
    const list = await listTagBudgetsAction();
    setRows(list as BudgetRow[]);
  }
  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    startEval(async () => {
      const res = await evaluateTagBudgetsAction();
      setEvalResults(new Map(res.map((r) => [r.id, r])));
    });
  }, [rows.length]);

  const save = useAction(
    async (d: DraftRow, amount: number) =>
      toResult(
        await upsertTagBudgetAction({
          id: d.id,
          tagKey: d.tagKey.trim(),
          tagValue: d.tagValue.trim() || null,
          monthlyUsd: amount,
        }),
      ),
    {
      success: t("toast.saved"),
      onSuccess: () => {
        setDraft(null);
        void refresh();
      },
    },
  );

  const remove = useAction(async (id: string) => toResult(await deleteTagBudgetAction(id)), {
    success: t("toast.deleted"),
    onSuccess: () => void refresh(),
  });

  function submit() {
    if (!draft) return;
    const amount = Number.parseFloat(draft.monthlyUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("toast.invalidAmount"));
      return;
    }
    void save.run(draft, amount);
  }

  return (
    <PageSection
      title={t("title")}
      description={t("description", { hours: HOURS_PER_MONTH })}
      action={
        <Button variant="outline" size="sm" onClick={() => setDraft({ tagKey: "", tagValue: "", monthlyUsd: "" })} disabled={save.pending || draft !== null}>
          <Plus className="size-3.5" aria-hidden /> {t("add")}
        </Button>
      }
    >
      <div className="space-y-3">
        {rows.length === 0 && !draft && <p className="text-xs text-muted">{t("empty")}</p>}

        <AnimatePresence initial={false}>
          {rows.map((b) => {
            const ev = evalResults.get(b.id);
            const observed = ev?.observedUsd ?? b.lastObservedUsd ?? 0;
            const exceeded = ev?.exceeded ?? b.exceeded === 1;
            const pct = b.monthlyUsd > 0 ? (observed / b.monthlyUsd) * 100 : 0;
            const tone = exceeded ? "danger" : pct > 80 ? "warning" : "success";
            const tagLabel = b.tagValue ? `${b.tagKey}=${b.tagValue}` : b.tagKey;
            return (
              <m.div
                key={b.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="rounded-[var(--radius-md)] border border-border bg-bg-muted/40 p-3 text-xs"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">
                      {b.tagKey}
                      {b.tagValue ? `=${b.tagValue}` : <span className="text-muted"> {t("anyValue")}</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
                      <span>{t("observed", { observed: usd(observed), cap: usd(b.monthlyUsd) })}</span>
                      {ev?.daysToExceed != null && ev.daysToExceed > 0 && !exceeded && (
                        <span className="text-warning">{t("daysToCap", { days: ev.daysToExceed })}</span>
                      )}
                    </div>
                  </div>
                  {exceeded && (
                    <span className="flex shrink-0 items-center gap-1 text-danger">
                      <AlertTriangle className="size-3.5" aria-hidden /> {t("overBudget")}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted hover:text-danger"
                    aria-label={t("delete", { tag: tagLabel })}
                    loading={remove.pending}
                    onClick={() => void remove.run(b.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
                <Progress value={Math.min(100, pct)} size="sm" tone={tone} className="mt-2" />
              </m.div>
            );
          })}
        </AnimatePresence>

        {draft && (
          <form
            className="space-y-3 rounded-[var(--radius-md)] border border-dashed border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor={`${formId}-key`}>{t("form.tagKey")}</Label>
                <Input
                  id={`${formId}-key`}
                  placeholder={t("form.tagKeyPlaceholder")}
                  value={draft.tagKey}
                  onChange={(e) => setDraft({ ...draft, tagKey: e.target.value })}
                  className="font-mono"
                  maxLength={64}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-value`}>{t("form.tagValue")}</Label>
                <Input
                  id={`${formId}-value`}
                  placeholder={t("form.tagValuePlaceholder")}
                  value={draft.tagValue}
                  onChange={(e) => setDraft({ ...draft, tagValue: e.target.value })}
                  className="font-mono"
                  maxLength={256}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-amount`}>{t("form.monthlyUsd")}</Label>
                <Input
                  id={`${formId}-amount`}
                  placeholder={t("form.monthlyUsdPlaceholder")}
                  value={draft.monthlyUsd}
                  onChange={(e) => setDraft({ ...draft, monthlyUsd: e.target.value })}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  required
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" loading={save.pending} disabled={!draft.tagKey.trim()}>
                {tCommon("save")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={save.pending}>
                {tCommon("cancel")}
              </Button>
              {evaluating && <span className="ml-auto text-[11px] text-muted">{t("evaluating")}</span>}
            </div>
          </form>
        )}
      </div>
    </PageSection>
  );
}
