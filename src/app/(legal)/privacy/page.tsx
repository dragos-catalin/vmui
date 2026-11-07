import { LegalList, LegalText, MailLink } from "@/components/legal/legal-bits";
import { PageHeader, PageSection, PageShell } from "@/components/ui";
import { legalConfig } from "@/lib/legal/config";
import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.privacy");
  return { title: t("metaTitle") };
}

export default async function PrivacyPage() {
  const t = await getTranslations("legal.privacy");
  const c = legalConfig();
  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<ShieldCheck />} />
      <PageSection title={t("controller.title")}>
        <LegalText>{t("controller.body", { publisher: c.publisher })}</LegalText>
      </PageSection>
      <PageSection title={t("local.title")}>
        <LegalList items={t.raw("local.items") as string[]} />
      </PageSection>
      <PageSection title={t("leaves.title")}>
        <LegalList items={t.raw("leaves.items") as string[]} />
      </PageSection>
      <PageSection title={t("ai.title")}>
        <LegalText>{t("ai.body")}</LegalText>
      </PageSection>
      <PageSection title={t("retention.title")}>
        <LegalText>{t("retention.body")}</LegalText>
      </PageSection>
      <PageSection title={t("rights.title")}>
        <LegalText>{t("rights.body", { email: c.privacyEmail })}</LegalText>
        <p className="mt-2 text-sm">
          <MailLink email={c.privacyEmail} /> · <Link href="/account/delete" className="underline underline-offset-4">/account/delete</Link>
        </p>
      </PageSection>
      <LegalText>{t("complaint")}</LegalText>
      <p className="text-xs text-fg-muted">{t("more")}</p>
    </PageShell>
  );
}
