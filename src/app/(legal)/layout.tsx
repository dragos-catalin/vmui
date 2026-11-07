import { LocaleSwitcher } from "@/components/nav/locale-switcher";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

/** Public legal pages (P11-01): no app shell, readable without an account. */
export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("legal");
  const links = [
    { href: "/privacy", label: t("nav.privacy") },
    { href: "/legal", label: t("nav.legal") },
    { href: "/licenses", label: t("nav.licenses") },
    { href: "/account/delete", label: t("nav.deleteAccount") },
  ];
  return (
    <div className="w-full max-w-3xl space-y-6 self-start">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t("nav.label")}>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-fg-muted underline-offset-4 hover:text-fg hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <LocaleSwitcher />
      </div>
      <p role="note" className="rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 py-2 text-xs text-fg-muted">
        {t("draft")}
      </p>
      {children}
    </div>
  );
}
