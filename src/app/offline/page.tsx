import { Alert, Button, EmptyState, PageHeader, PageShell } from "@/components/ui";
import { LayoutDashboard, WifiOff } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("observe.offline");
  return { title: t("title") };
}

export default async function OfflinePage() {
  const t = await getTranslations("observe.offline");
  return (
    <PageShell width="prose">
      <PageHeader title={t("title")} description={t("description")} icon={<WifiOff />} />
      <EmptyState
        illustration="offline"
        title={t("empty.title")}
        description={t("empty.description")}
        action={
          <Button asChild>
            <Link href="/">
              <LayoutDashboard className="size-4" aria-hidden /> {t("openDashboard")}
            </Link>
          </Button>
        }
      />
      <Alert tone="info" title={t("whatWorks.title")}>
        <ul className="list-disc space-y-1 pl-4">
          <li>{t("whatWorks.live")}</li>
          <li>{t("whatWorks.cached")}</li>
          <li>{t("whatWorks.sw")}</li>
        </ul>
      </Alert>
    </PageShell>
  );
}
