"use client";

import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { AlertTriangle, House, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

/** /home has its own boundary so a failed loader (HA, DB) keeps the shell and offers a retry. */
export default function HomeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("home");
  const errors = useTranslations("errors");
  return (
    <PageShell>
      <PageHeader title={t("title")} icon={<House />} />
      <div role="alert" className="surface mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-danger)_12%,transparent)] text-danger">
          <AlertTriangle className="size-6" aria-hidden />
        </span>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{t("error.title")}</h2>
          <p className="text-balance text-sm text-muted">{t("error.hint")}</p>
          {error.digest ? <p className="font-mono text-xs text-muted">{errors("digest", { id: error.digest })}</p> : null}
        </div>
        <Button onClick={reset}>
          <RotateCcw className="size-4" aria-hidden /> {t("error.retry")}
        </Button>
      </div>
    </PageShell>
  );
}
