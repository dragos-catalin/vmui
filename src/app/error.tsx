"use client";

import { VatraMark } from "@/components/brand/vatra-mark";
import { Button } from "@/components/ui/button";
import { Home, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errors");
  const tc = useTranslations("common");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <VatraMark size={56} state="error" className="text-fg-soft" />
      <div className="space-y-1">
        <h1 className="text-balance font-display text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-pretty text-sm text-fg-muted">{t("hint")}</p>
        {error.digest ? (
          <p className="font-mono text-xs text-fg-muted">{t("digest", { id: error.digest })}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={reset}>
          <RotateCcw className="size-4" aria-hidden /> {tc("retry")}
        </Button>
        <Button asChild variant="secondary">
          <Link href="/">
            <Home className="size-4" aria-hidden /> {t("home")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
