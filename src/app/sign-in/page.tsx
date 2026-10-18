import { AuthCard, AuthDivider } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInWithPasskeyButton } from "@/components/auth/sign-in-with-passkey-button";
import { userCount } from "@/lib/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("signIn") };
}

export default async function SignInPage() {
  const n = await userCount();
  if (n === 0) {
    redirect("/sign-up");
  }
  const t = await getTranslations("auth.signIn");
  return (
    <AuthCard title={t("title")} description={t("description")} footer={t("noAccount")}>
      <div className="space-y-4">
        <SignInForm />
        <AuthDivider />
        <SignInWithPasskeyButton />
      </div>
    </AuthCard>
  );
}
