import { AuthCard } from "@/components/auth/auth-card";
import { RestoreForm } from "@/components/auth/restore-form";
import { userCount } from "@/lib/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("restore") };
}

/** Unclaimed hub only (P5-06); a claimed hub restores from Settings → Data. */
export default async function SetupRestorePage() {
  if ((await userCount()) > 0) redirect("/settings");
  const t = await getTranslations("auth.restore");
  return (
    <AuthCard
      title={t("title")}
      description={t("description")}
      footer={
        <Link href="/sign-up" className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {t("claimInstead")}
        </Link>
      }
    >
      <RestoreForm />
    </AuthCard>
  );
}
