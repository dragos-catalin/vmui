import { getTranslations } from "next-intl/server";

/** First focusable element on every page: jumps keyboard users past the sidebar and topbar to `<main id="main">`. */
export async function SkipLink({ target = "main" }: { target?: string }) {
  const t = await getTranslations("shell");
  return (
    <a
      href={`#${target}`}
      className="sr-only fixed left-3 top-3 z-[var(--z-splash)] rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-[var(--shadow-md)] focus:not-sr-only focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {t("skipToContent")}
    </a>
  );
}
