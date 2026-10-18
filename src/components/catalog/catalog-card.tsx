"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { Badge, Button } from "@/components/ui";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import type { CatalogTemplate } from "@/lib/catalog";
import { saveCatalogTemplateAction } from "@/server/actions/catalog";
import { Copy, ExternalLink, FileCode2, Save } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useState } from "react";

type CatalogCategory = CatalogTemplate["category"];

const CATEGORY_VARIANT: Record<CatalogCategory, "default" | "success" | "warning" | "danger" | "info" | "muted"> = {
  automation: "info",
  analytics: "warning",
  docs: "success",
  monitoring: "info",
  security: "danger",
  dev: "muted",
};

export function CatalogCard({ template, index = 0 }: { template: CatalogTemplate; index?: number }) {
  const t = useTranslations("ops.catalog");
  const [open, setOpen] = useState(false);

  const save = useAction(
    async (): Promise<ActionResult> => {
      const res = await saveCatalogTemplateAction(template.id);
      return res.ok ? ok() : { ok: false, error: res.error ?? t("saveFailed") };
    },
    { success: t("saved", { name: template.name }) },
  );

  const copy = async () => {
    await navigator.clipboard.writeText(template.cloudInit);
  };

  return (
    <>
      <m.article
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.03 }}
        className="surface card-hover flex flex-col gap-3 p-4"
      >
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{template.name}</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge variant={CATEGORY_VARIANT[template.category]}>{t(`categories.${template.category}`)}</Badge>
              <Badge variant="muted">{t("port", { port: template.defaultPort })}</Badge>
            </div>
          </div>
          <Button asChild variant="ghost" size="icon" aria-label={t("homepage", { name: template.name })}>
            <a href={template.homepage} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </Button>
        </header>

        <p className="flex-1 text-sm text-fg-muted">{template.description}</p>

        <dl className="grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <dt className="text-fg-muted">{t("specs.vcpu")}</dt>
            <dd className="font-mono tabular-nums">{template.recommends.vcpu}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t("specs.ram")}</dt>
            <dd className="font-mono tabular-nums">{t("specs.gb", { n: template.recommends.ramGb })}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t("specs.disk")}</dt>
            <dd className="font-mono tabular-nums">{t("specs.gb", { n: template.recommends.diskGb })}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save.run()} loading={save.pending}>
            <Save className="size-4" aria-hidden /> {t("use")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <FileCode2 className="size-4" aria-hidden /> {t("view")}
          </Button>
        </div>
      </m.article>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={template.name} description={template.description} className="md:w-[640px]">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void save.run()} loading={save.pending}>
                <Save className="size-4" aria-hidden /> {t("use")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                <Copy className="size-4" aria-hidden /> {t("copyYaml")}
              </Button>
            </div>
            <LogViewer title={t("cloudInit")} text={template.cloudInit} height="max-h-[60vh]" wrap autoScroll={false} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
