import { LegalText, MailLink, Placeholder } from "@/components/legal/legal-bits";
import { PageHeader, PageSection, PageShell } from "@/components/ui";
import { legalConfig, PLACEHOLDER_POSTAL } from "@/lib/legal/config";
import { Scale } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.legal");
  return { title: t("metaTitle") };
}

export default async function LegalPage() {
  const t = await getTranslations("legal.legal");
  const tl = await getTranslations("legal");
  const c = legalConfig();
  const env = process.env;
  const rows: Array<{ label: string; value: React.ReactNode; placeholder: boolean }> = [
    { label: t("publisher.name"), value: c.publisher, placeholder: false },
    { label: t("publisher.country"), value: c.country, placeholder: false },
    { label: t("publisher.postal"), value: c.postal, placeholder: c.postal === PLACEHOLDER_POSTAL },
    { label: t("publisher.phone"), value: c.phone, placeholder: c.phone === PLACEHOLDER_POSTAL },
  ];
  const contacts: Array<{ label: string; email: string; placeholder: boolean }> = [
    { label: t("contact.authorities"), email: c.privacyEmail, placeholder: !env.VATRA_PRIVACY_EMAIL },
    { label: t("contact.privacy"), email: c.privacyEmail, placeholder: !env.VATRA_PRIVACY_EMAIL },
    { label: t("contact.security"), email: c.securityEmail, placeholder: !env.VATRA_SECURITY_EMAIL },
  ];
  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<Scale />} />
      <PageSection title={t("publisher.title")} description={t("publisher.note")}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-fg-muted">{r.label}</dt>
              <dd>
                {r.value}
                <Placeholder show={r.placeholder} label={tl("placeholder")} />
              </dd>
            </div>
          ))}
        </dl>
      </PageSection>
      <PageSection title={t("contact.title")} description={t("contact.languages")}>
        <dl className="space-y-3 text-sm">
          {contacts.map((r) => (
            <div key={r.label}>
              <dt className="text-fg-muted">{r.label}</dt>
              <dd>
                <MailLink email={r.email} />
                <Placeholder show={r.placeholder} label={tl("placeholder")} />
              </dd>
            </div>
          ))}
        </dl>
      </PageSection>
      <PageSection title={t("hub.title")}>
        <LegalText>{t("hub.body")}</LegalText>
      </PageSection>
      <PageSection title={t("dsa.title")}>
        <LegalText>{t("dsa.body")}</LegalText>
      </PageSection>
    </PageShell>
  );
}
