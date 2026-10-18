import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Home } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("errors");
  return { title: t("notFoundTitle") };
}

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <div className="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col justify-center px-4">
      <h1 className="sr-only">{t("notFoundTitle")}</h1>
      <EmptyState
        illustration="search"
        title={t("notFoundTitle")}
        description={t("notFoundHint")}
        action={
          <Button asChild>
            <Link href="/">
              <Home className="size-4" aria-hidden /> {t("home")}
            </Link>
          </Button>
        }
      />
    </div>
  );
}
