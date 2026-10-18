"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { Badge, Button, EmptyState } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import {
    recipeDryRun,
    recipeRebootAllRunning,
    recipeStartAllStopped,
    recipeStopAllRunning,
    type RecipeResult,
} from "@/server/actions/recipes";
import { Eye, Play, RefreshCw, StopCircle } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useState } from "react";

type RecipeId = "stop-all-running" | "start-all-stopped" | "reboot-all-running";
type RecipeTag = "cost" | "fleet" | "maintenance";
type Candidate = Awaited<ReturnType<typeof recipeDryRun>>[number];

interface Recipe {
  id: RecipeId;
  icon: typeof Play;
  tone: "danger" | "success" | "warning";
  tags: RecipeTag[];
  run: () => Promise<RecipeResult>;
}

const RECIPES: Recipe[] = [
  { id: "stop-all-running", icon: StopCircle, tone: "danger", tags: ["cost", "fleet"], run: () => recipeStopAllRunning() },
  { id: "start-all-stopped", icon: Play, tone: "success", tags: ["fleet"], run: () => recipeStartAllStopped() },
  { id: "reboot-all-running", icon: RefreshCw, tone: "warning", tags: ["maintenance", "fleet"], run: () => recipeRebootAllRunning() },
];

const TONE_TEXT: Record<Recipe["tone"], string> = {
  danger: "text-danger",
  success: "text-success",
  warning: "text-warning",
};
const TONE_BADGE: Record<Recipe["tone"], "danger" | "success" | "warning"> = {
  danger: "danger",
  success: "success",
  warning: "warning",
};

export function RecipesGrid() {
  const t = useTranslations("ops.recipes");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [active, setActive] = useState<Recipe | null>(null);
  const [previews, setPreviews] = useState<Partial<Record<RecipeId, Candidate[]>>>({});
  const [results, setResults] = useState<Partial<Record<RecipeId, RecipeResult>>>({});

  const preview = useAction(
    async (r: Recipe): Promise<ActionResult> => {
      const list = await recipeDryRun(r.id);
      setPreviews((p) => ({ ...p, [r.id]: list }));
      return ok();
    },
    { refresh: false },
  );

  const execute = useAction(
    async (r: Recipe): Promise<ActionResult<RecipeResult>> => {
      const res = await r.run();
      setResults((p) => ({ ...p, [r.id]: res }));
      if (res.failed.length > 0 && res.ok === 0) {
        return { ok: false, error: t("runFailed", { failed: res.failed.length, total: res.totalCandidates }) };
      }
      return ok(res);
    },
    { success: (res) => t("runDone", { ok: res.ok, total: res.totalCandidates, failed: res.failed.length }) },
  );

  async function openAndPreview(r: Recipe) {
    setActive(r);
    if (!previews[r.id]) await preview.run(r);
  }

  async function onRun(r: Recipe) {
    const yes = await confirm({
      title: t("confirmTitle", { name: t(`items.${r.id}.label`) }),
      description: t("confirmHint"),
      tone: r.tone === "success" ? "info" : r.tone,
      confirmText: t("run"),
      requireText: r.tone === "danger" ? t(`items.${r.id}.confirmWord`) : undefined,
    });
    if (yes) await execute.run(r);
  }

  const activeList = active ? previews[active.id] : undefined;
  const activeResult = active ? results[active.id] : undefined;
  const resultLines = activeResult
    ? [
        t("log.summary", { ok: activeResult.ok, total: activeResult.totalCandidates, failed: activeResult.failed.length }),
        ...activeResult.failed.map((f) => t("log.failedLine", { id: f.id, error: f.error })),
      ]
    : [];

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
        {RECIPES.map((r, i) => {
          const Icon = r.icon;
          const list = previews[r.id];
          return (
            <m.article
              key={r.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: i * 0.03 }}
              className="surface card-hover flex min-w-0 flex-col gap-3 p-4"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-bg-muted ${TONE_TEXT[r.tone]}`} aria-hidden>
                    <Icon className="size-4" />
                  </span>
                  <h3 className="min-w-0 break-words text-sm font-semibold">{t(`items.${r.id}.label`)}</h3>
                </div>
                <Badge variant={TONE_BADGE[r.tone]}>{t(`tones.${r.tone}`)}</Badge>
              </header>
              <p className="flex-1 text-sm text-fg-muted">{t(`items.${r.id}.description`)}</p>
              <div className="flex flex-wrap gap-1.5">
                {r.tags.map((tag) => (
                  <Badge key={tag} variant="muted">
                    {t(`tags.${tag}`)}
                  </Badge>
                ))}
                {list && <Badge variant="info">{t("affects", { count: list.length })}</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void openAndPreview(r)}>
                  <Eye className="size-4" aria-hidden /> {t("preview")}
                </Button>
                <Button size="sm" variant={r.tone === "danger" ? "danger" : "primary"} onClick={() => void onRun(r)} loading={execute.pending}>
                  <Play className="size-4" aria-hidden /> {t("run")}
                </Button>
              </div>
            </m.article>
          );
        })}
      </div>

      <Sheet open={active !== null} onOpenChange={(o) => !o && setActive(null)}>
        {active && (
          <SheetContent title={t(`items.${active.id}.label`)} description={t(`items.${active.id}.description`)} className="md:w-[560px]">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t("previewTitle")}</h3>
                <Button size="sm" variant="ghost" onClick={() => void preview.run(active)} loading={preview.pending}>
                  <RefreshCw className="size-4" aria-hidden /> {tc("refresh")}
                </Button>
              </div>
              {preview.pending && !activeList ? (
                <p className="text-xs text-fg-muted">{tc("loading")}</p>
              ) : activeList && activeList.length > 0 ? (
                <ul className="max-h-72 space-y-1 overflow-auto rounded-[var(--radius-md)] border border-border p-2 text-xs">
                  {activeList.map((c) => (
                    <li key={c.id} className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono">{c.name ?? c.id}</span>
                      <Badge variant="muted">{c.provider}</Badge>
                      <span className="ml-auto shrink-0 text-fg-muted">{c.region}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState compact title={t("noCandidates")} description={t("noCandidatesHint")} />
              )}
              <div className="flex justify-end">
                <Button variant={active.tone === "danger" ? "danger" : "primary"} onClick={() => void onRun(active)} loading={execute.pending} disabled={!activeList || activeList.length === 0}>
                  <Play className="size-4" aria-hidden /> {t("runOn", { count: activeList?.length ?? 0 })}
                </Button>
              </div>
              {activeResult && (
                <LogViewer
                  title={t("log.title")}
                  lines={resultLines}
                  height="max-h-60"
                  searchable={false}
                  wrap
                  lineTone={(_line, i) => (i === 0 ? (activeResult.failed.length ? "warning" : "success") : "danger")}
                />
              )}
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
