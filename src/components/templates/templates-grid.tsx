"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button, EmptyState } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { deleteLaunchTemplateAction } from "@/server/actions/templates-and-budgets";
import { Eye, LayoutTemplate, Rocket, Trash2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

export interface LaunchTemplateCard {
  id: string;
  name: string;
  description: string | null;
  accountId: string;
  accountName: string;
  region: string;
  instanceType: string;
  platform: string;
  configJson: string;
  createdAt: Date;
}

const PLATFORMS = ["linux", "windows", "macos"] as const;
type Platform = (typeof PLATFORMS)[number];
const asPlatform = (p: string): Platform => (PLATFORMS.includes(p as Platform) ? (p as Platform) : "linux");

function launchHref(t: LaunchTemplateCard): string {
  return `/instances/new?accountId=${encodeURIComponent(t.accountId)}&region=${encodeURIComponent(t.region)}&instanceType=${encodeURIComponent(
    t.instanceType,
  )}&platform=${t.platform}&fromTemplate=${t.id}`;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function TemplatesGrid({ templates }: { templates: LaunchTemplateCard[] }) {
  const t = useTranslations("ops.templates");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [detail, setDetail] = useState<LaunchTemplateCard | null>(null);

  const remove = useAction(
    async (id: string): Promise<ActionResult> => {
      await deleteLaunchTemplateAction(id);
      return ok();
    },
    { success: t("deleted"), onSuccess: () => setDetail(null) },
  );

  async function onRemove(tpl: LaunchTemplateCard) {
    const yes = await confirm({
      title: t("confirmDelete", { name: tpl.name }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(tpl.id);
  }

  if (templates.length === 0) {
    return (
      <EmptyState
        icon={<LayoutTemplate />}
        title={t("empty")}
        description={t("emptyHint")}
        action={
          <Button asChild size="sm">
            <Link href="/instances">{t("goToInstances")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
        <AnimatePresence initial={false}>
          {templates.map((tpl, i) => (
            <m.article
              key={tpl.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
              className="surface card-hover flex flex-col gap-3 p-4"
            >
              <header className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{tpl.name}</h3>
                {tpl.description && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{tpl.description}</p>}
              </header>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="info">{tpl.accountName}</Badge>
                <Badge variant="muted">{tpl.region}</Badge>
                <Badge variant="muted">{t(`platforms.${asPlatform(tpl.platform)}`)}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="min-w-0">
                  <dt className="text-fg-muted">{t("instanceType")}</dt>
                  <dd className="truncate font-mono">{tpl.instanceType}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">{t("created")}</dt>
                  <dd>
                    <RelativeTime date={tpl.createdAt} />
                  </dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link href={launchHref(tpl)}>
                    <Rocket className="size-4" aria-hidden /> {t("launch")}
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDetail(tpl)}>
                  <Eye className="size-4" aria-hidden /> {t("view")}
                </Button>
                <Button size="icon" variant="ghost" className="ml-auto" onClick={() => void onRemove(tpl)} disabled={remove.pending} aria-label={tc("delete")}>
                  <Trash2 className="size-4 text-danger" aria-hidden />
                </Button>
              </div>
            </m.article>
          ))}
        </AnimatePresence>
      </div>

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        {detail && (
          <SheetContent title={detail.name} description={detail.description ?? undefined} className="md:w-[640px]">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="info">{detail.accountName}</Badge>
                <Badge variant="muted">{detail.region}</Badge>
                <Badge variant="muted">{t(`platforms.${asPlatform(detail.platform)}`)}</Badge>
                <Badge variant="default">{detail.instanceType}</Badge>
              </div>
              <LogViewer title={t("config")} text={prettyJson(detail.configJson)} height="max-h-[55vh]" wrap autoScroll={false} />
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => void onRemove(detail)} disabled={remove.pending}>
                  <Trash2 className="size-4 text-danger" aria-hidden /> {tc("delete")}
                </Button>
                <Button asChild>
                  <Link href={launchHref(detail)}>
                    <Rocket className="size-4" aria-hidden /> {t("launch")}
                  </Link>
                </Button>
              </div>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
