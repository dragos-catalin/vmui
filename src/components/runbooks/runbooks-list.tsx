"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, EmptyState } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { deleteRunbookAction } from "@/server/actions/automation";
import { BookOpen, Eye, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useState } from "react";

export interface RunbookCard {
  id: string;
  title: string;
  body: string;
  accountId: string | null;
  providerInstanceId: string | null;
  updatedAt: Date;
}

function lineTone(line: string): "default" | "muted" | "success" | "warning" | undefined {
  const l = line.trimStart();
  if (l.startsWith("#")) return "warning";
  if (/^[-*] \[x\]/i.test(l)) return "success";
  if (l.startsWith(">")) return "muted";
  return undefined;
}

export function RunbooksList({ runbooks }: { runbooks: RunbookCard[] }) {
  const t = useTranslations("ops.runbooks");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [detail, setDetail] = useState<RunbookCard | null>(null);

  const remove = useAction(
    async (id: string): Promise<ActionResult> => {
      await deleteRunbookAction(id);
      return ok();
    },
    { success: t("deleted"), onSuccess: () => setDetail(null) },
  );

  async function onRemove(r: RunbookCard) {
    const yes = await confirm({
      title: t("confirmDelete", { name: r.title }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(r.id);
  }

  if (runbooks.length === 0) {
    return <EmptyState icon={<BookOpen />} title={t("empty")} description={t("emptyHint")} />;
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
        <AnimatePresence initial={false}>
          {runbooks.map((r, i) => (
            <m.article
              key={r.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
              className="surface card-hover flex flex-col gap-3 p-4"
            >
              <header className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate text-sm font-semibold">{r.title}</h3>
                {r.providerInstanceId ? (
                  <Badge variant="info" className="max-w-[10rem] truncate font-mono">
                    {r.providerInstanceId}
                  </Badge>
                ) : (
                  <Badge variant="muted">{t("fleetWide")}</Badge>
                )}
              </header>
              <pre className="line-clamp-4 whitespace-pre-wrap font-mono text-xs text-fg-muted">{r.body || t("noBody")}</pre>
              <div className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
                <span>{t("updated")}</span>
                <RelativeTime date={r.updatedAt} />
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => setDetail(r)}>
                    <Eye className="size-4" aria-hidden /> {t("view")}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => void onRemove(r)} disabled={remove.pending} aria-label={tc("delete")}>
                    <Trash2 className="size-4 text-danger" aria-hidden />
                  </Button>
                </div>
              </div>
            </m.article>
          ))}
        </AnimatePresence>
      </div>

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        {detail && (
          <SheetContent title={detail.title} description={detail.providerInstanceId ?? t("fleetWide")} className="md:w-[640px]">
            <div className="space-y-4">
              <LogViewer title={t("body")} text={detail.body} height="max-h-[60vh]" wrap autoScroll={false} lineTone={lineTone} emptyLabel={t("noBody")} />
              <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                <span>
                  {t("updated")} <RelativeTime date={detail.updatedAt} />
                </span>
                <Button variant="ghost" size="sm" onClick={() => void onRemove(detail)} disabled={remove.pending}>
                  <Trash2 className="size-4 text-danger" aria-hidden /> {tc("delete")}
                </Button>
              </div>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
