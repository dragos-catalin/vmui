"use client";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { Container as ContainerIcon, House, Menu, Server, TerminalSquare } from "lucide-react";
import { useMotionValueEvent, useScroll } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { isNavActive, NAV_GROUPS, NAV_SETTINGS, type NavItem } from "./nav-model";

const TABS: Array<NavItem & { labelKey: "vms" | "apps" | "shell" | null }> = [
  { id: "instances", href: "/", icon: Server, exact: true, labelKey: "vms" },
  { id: "home", href: "/home", icon: House, labelKey: null },
  { id: "containers", href: "/containers", icon: ContainerIcon, labelKey: "apps" },
  { id: "terminal", href: "/terminal", icon: TerminalSquare, labelKey: "shell" },
];

const SCROLL_THRESHOLD = 8;

function useHideOnScroll(): boolean {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  useMotionValueEvent(scrollY, "change", (y) => {
    const dy = y - last.current;
    if (y <= 0) setHidden(false);
    else if (Math.abs(dy) >= SCROLL_THRESHOLD) setHidden(dy > 0);
    last.current = y;
  });
  return hidden;
}

const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export function MobileNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const t = useTranslations("shell");
  const [showMore, setShowMore] = useState(false);
  const hidden = useHideOnScroll();
  const close = () => setShowMore(false);
  if (compact) return null;
  const inTabs = TABS.some((it) => isNavActive(pathname, it));
  const moreActive = !inTabs && pathname !== "/";

  const itemLabel = (id: string) => t(`items.${id}` as Parameters<typeof t>[0]);

  return (
    <>
      <m.nav
        aria-label={t("sidebar.label")}
        animate={{ y: hidden && !showMore ? "100%" : 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-x-0 bottom-0 z-[var(--z-nav)] flex justify-around border-t border-border bg-[color-mix(in_oklch,var(--color-surface)_92%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        {TABS.map((it) => {
          const active = isNavActive(pathname, it);
          const Icon = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={active ? "page" : undefined}
              onClick={() => haptic("tap")}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-[var(--radius-md)] py-2 text-xs font-medium transition",
                FOCUS,
                active ? "text-primary-text" : "text-fg-muted hover:text-fg",
              )}
            >
              <span className="relative grid size-8 place-items-center">
                {active && (
                  <m.span
                    layoutId="mobile-nav-indicator"
                    className="absolute inset-0 rounded-full bg-[color-mix(in_oklch,var(--color-primary)_16%,transparent)]"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    aria-hidden
                  />
                )}
                <Icon className="relative size-5" aria-hidden />
              </span>
              <span className="max-w-full truncate px-0.5">{it.labelKey ? t(`mobile.${it.labelKey}`) : itemLabel(it.id)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => {
            haptic("tap");
            setShowMore(true);
          }}
          aria-expanded={showMore}
          aria-haspopup="dialog"
          className={cn(
            "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-[var(--radius-md)] py-2 text-xs font-medium transition",
            FOCUS,
            moreActive ? "text-primary-text" : "text-fg-muted hover:text-fg",
          )}
        >
          <span className="relative grid size-8 place-items-center">
            {moreActive && (
              <m.span
                layoutId="mobile-nav-indicator"
                className="absolute inset-0 rounded-full bg-[color-mix(in_oklch,var(--color-primary)_16%,transparent)]"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                aria-hidden
              />
            )}
            <Menu className="relative size-5" aria-hidden />
          </span>
          <span className="max-w-full truncate px-0.5">{t("mobile.more")}</span>
        </button>
      </m.nav>

      <Sheet open={showMore} onOpenChange={setShowMore}>
        <SheetContent title={t("mobile.allSections")} className="md:hidden">
              <div className="min-h-0 space-y-4">
              {[...NAV_GROUPS, { id: "settings" as const, items: [NAV_SETTINGS] }].map((g) => (
                <section key={g.id} aria-label={g.id === "settings" ? itemLabel("settings") : t(`groups.${g.id}`)}>
                  <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-fg-muted">{g.id === "settings" ? itemLabel("settings") : t(`groups.${g.id}`)}</h3>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {g.items.map((item) => {
                      const active = isNavActive(pathname, item);
                      const Icon = item.icon;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => {
                            haptic("tap");
                            close();
                          }}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex min-w-0 flex-col items-center gap-1 rounded-[var(--radius-md)] border border-border bg-bg-muted p-3 text-center text-xs font-medium transition active:scale-95",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                            active ? "border-primary text-primary-text" : "text-fg hover:bg-surface",
                          )}
                        >
                          <Icon className="size-5" aria-hidden />
                          <span className="line-clamp-2 w-full break-words leading-tight">{itemLabel(item.id)}</span>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              ))}
              </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
