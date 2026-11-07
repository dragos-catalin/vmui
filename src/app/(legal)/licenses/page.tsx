import { LegalText } from "@/components/legal/legal-bits";
import { Alert, PageHeader, PageSection, PageShell } from "@/components/ui";
import { legalConfig } from "@/lib/legal/config";
import { parseNoticeMarkdown, type NoticeGroup } from "@/lib/legal/notice-core";
import { ExternalLink, FileCode2 } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.licenses");
  return { title: t("metaTitle") };
}

function readNotice(): NoticeGroup[] | null {
  try {
    // process.cwd() join: traced into the standalone image by Next's file tracing
    return parseNoticeMarkdown(readFileSync(join(process.cwd(), "NOTICE.md"), "utf8"));
  } catch {
    return null;
  }
}

export default async function LicensesPage() {
  const t = await getTranslations("legal.licenses");
  const c = legalConfig();
  const groups = readNotice();
  const total = groups?.reduce((n, g) => n + g.packages.length, 0) ?? 0;
  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<FileCode2 />} />
      <PageSection title={t("agpl.title")}>
        <LegalText>{t("agpl.body")}</LegalText>
        <p className="mt-2 text-sm">
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" className="underline underline-offset-4" rel="noreferrer">
            {t("agpl.full")}
          </a>
        </p>
      </PageSection>
      <PageSection title={t("source.title")}>
        <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-fg-muted">{t("source.version")}</dt>
          <dd className="font-mono">{c.version ?? t("source.unknown")}</dd>
          <dt className="text-fg-muted">{t("source.commit")}</dt>
          <dd className="font-mono">{c.commit ?? t("source.unknown")}</dd>
        </dl>
        <a href={c.sourceUrl} rel="noreferrer" className="inline-flex min-h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 text-sm font-medium hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <ExternalLink className="size-4" aria-hidden />
          {t("source.link")}
        </a>
        <p className="mt-2 break-all font-mono text-xs text-fg-muted">{c.sourceUrl}</p>
      </PageSection>
      <PageSection title={t("other.title")}>
        <LegalText>{t("other.body")}</LegalText>
      </PageSection>
      <PageSection title={t("third.title")} description={groups ? t("third.body", { count: total }) : undefined}>
        {!groups ? (
          <Alert tone="warning">{t("third.missing")}</Alert>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <details key={g.license} className="rounded-[var(--radius-md)] border border-border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  {t("third.group", { license: g.license, count: g.packages.length })}
                </summary>
                <ul className="max-h-80 space-y-0.5 overflow-y-auto border-t border-border px-3 py-2 text-xs">
                  {g.packages.map((p) => (
                    <li key={`${p.name}@${p.version}`} className="flex flex-wrap gap-x-2">
                      <span className="font-mono">
                        {p.name}@{p.version}
                      </span>
                      {p.url.startsWith("https://") && (
                        <a href={p.url} rel="noreferrer" className="text-fg-muted underline underline-offset-2">
                          {t("third.source")}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}
