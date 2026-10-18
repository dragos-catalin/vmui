import { AuthCard } from "@/components/auth/auth-card";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { getCurrentUser, ROLE_RANK, userCount } from "@/lib/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signUp") };
}

export default async function SignUpPage() {
  const n = await userCount();
  const isFirst = n === 0;
  if (!isFirst) {
    const me = await getCurrentUser();
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.admin) {
      redirect("/sign-in");
    }
  }
  const t = await getTranslations("auth.signUp");
  const footer = isFirst ? (
    <>
      {t("haveAccount")}{" "}
      <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {t("signInLink")}
      </Link>
    </>
  ) : (
    <Link href="/settings/users" className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {t("backToUsers")}
    </Link>
  );
  return (
    <AuthCard title={isFirst ? t("firstTitle") : t("addTitle")} description={isFirst ? t("firstDescription") : t("addDescription")} footer={footer}>
      <SignUpForm firstUser={isFirst} />
    </AuthCard>
  );
}
