import { LegalList, LegalText, MailLink } from "@/components/legal/legal-bits";
import { DeleteAccountCard } from "@/components/settings/delete-account-card";
import { PageHeader, PageSection, PageShell } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { legalConfig } from "@/lib/legal/config";
import { UserX } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.deleteAccount");
  return { title: t("metaTitle") };
}

/** Public account-deletion page (Google Play web deletion requirement, Apple 5.1.1(v)). */
export default async function DeleteAccountPage() {
  const t = await getTranslations("legal.deleteAccount");
  const tc = await getTranslations("legal.accountCard");
  const c = legalConfig();
  // signed in (family members land here from the steps: /settings is not theirs): delete right here
  const me = await getCurrentUser().catch(() => null);
  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<UserX />} />
      {me && (
        <PageSection title={tc("title")} description={me.email}>
          <DeleteAccountCard />
        </PageSection>
      )}
      <PageSection title={t("hub.title")}>
        <LegalList ordered items={t.raw("hub.steps") as string[]} />
      </PageSection>
      <PageSection title={t("apps.title")}>
        <LegalText>{t("apps.body")}</LegalText>
      </PageSection>
      <PageSection title={t("owner.title")}>
        <LegalText>{t("owner.body")}</LegalText>
      </PageSection>
      <PageSection title={t("email.title")}>
        <LegalText>{t("email.body", { email: c.privacyEmail })}</LegalText>
        <p className="mt-2 text-sm">
          <MailLink email={c.privacyEmail} />
        </p>
      </PageSection>
      <PageSection title={t("deleted.title")}>
        <LegalList items={t.raw("deleted.items") as string[]} />
      </PageSection>
      <PageSection title={t("kept.title")}>
        <LegalText>{t("kept.body")}</LegalText>
      </PageSection>
    </PageShell>
  );
}
