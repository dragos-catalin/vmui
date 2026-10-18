"use client";

import { VatraMark } from "@/components/brand/vatra-mark";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { isNavActive, NAV_GROUPS, NAV_PRIMARY, NAV_SETTINGS, type NavGroup, type NavItem } from "./nav-model";
import { useIsNavigating } from "./nav-progress";
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_COOKIE, SIDEBAR_TOGGLE_EVENT } from "./shell-events";

const STORAGE_KEY = "vmui.sidebar.open";
const DEFAULT_OPEN: Record<NavGroup["id"], boolean> = { cloud: true, ops: true, observe: true, govern: false, more: false };

const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } } as const;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function applyRailAttr(rail: boolean) {
  document.documentElement.dataset.sidebar = rail ? "rail" : "full";
}

function persistRail(rail: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, rail ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  document.cookie = `${SIDEBAR_COOKIE}=${rail ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
}

function useRail(initialCollapsed: boolean | undefined): [boolean, () => void] {
  const [rail, setRail] = React.useState(initialCollapsed ?? false);
  React.useEffect(() => {
    // The server already rendered the cookie's value; only guess when there was no cookie.
    if (initialCollapsed !== undefined) {
      applyRailAttr(initialCollapsed);
      return;
    }
    let initial: boolean;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      initial = raw !== null ? raw === "1" : !window.matchMedia("(min-width: 80rem)").matches;
    } catch {
      initial = false;
    }
    setRail(initial);
    applyRailAttr(initial);
    persistRail(initial);
  }, [initialCollapsed]);
  const toggle = React.useCallback(() => {
    setRail((r) => {
      const next = !r;
      persistRail(next);
      applyRailAttr(next);
      return next;
    });
  }, []);
  React.useEffect(() => {
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, toggle);
  }, [toggle]);
  return [rail, toggle];
}

function NavLink({ item, active, rail }: { item: NavItem; active: boolean; rail: boolean }) {
  const t = useTranslations("shell.items");
  const Icon = item.icon;
  const label = t(item.id as Parameters<typeof t>[0]);
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? label : undefined}
      className={cn(
        "group flex min-h-8 items-center gap-3 rounded-[var(--radius-md)] py-1.5 text-sm transition-colors",
        FOCUS,
        rail ? "justify-center px-0" : "px-3",
        active
          ? "bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] font-medium text-fg"
          : "text-fg-muted hover:bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] hover:text-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary-text")} aria-hidden />
      <AnimatePresence initial={false}>
        {!rail && (
          <m.span key="label" {...FADE} className="truncate" title={label}>
            {label}
          </m.span>
        )}
      </AnimatePresence>
    </Link>
  );
  if (!rail) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function BrandMark() {
  const navigating = useIsNavigating();
  return (
    <m.span layoutId="vatra-brand-mark" className="grid size-9 shrink-0 place-items-center text-fg">
      <VatraMark size={28} interactive label="Vatra" state={navigating ? "thinking" : "static"} />
    </m.span>
  );
}

export function Sidebar({ compact = false, initialCollapsed }: { compact?: boolean; initialCollapsed?: boolean }) {
  const pathname = usePathname();
  const t = useTranslations("shell");
  const [rail, toggleRail] = useRail(initialCollapsed);
  const [open, setOpen] = React.useState<Record<NavGroup["id"], boolean>>(DEFAULT_OPEN);
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setOpen((o) => ({ ...o, ...(JSON.parse(raw) as Partial<typeof o>) }));
    } catch {
      /* corrupt or blocked storage: keep defaults */
    }
  }, []);
  const toggle = (id: NavGroup["id"]) =>
    setOpen((o) => {
      const next = { ...o, [id]: !o[id] };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  const ToggleIcon = rail ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = rail ? t("sidebar.expand") : t("sidebar.collapse");

  return (
    <m.aside
      data-vmui-sidebar
      data-rail={rail ? "" : undefined}
      initial={false}
      animate={{ width: rail ? "var(--spacing-sidebar-rail)" : "var(--spacing-sidebar)" }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "hidden h-dvh min-w-0 shrink-0 flex-col overflow-x-clip border-r border-border bg-[color-mix(in_oklch,var(--color-surface)_50%,transparent)] backdrop-blur-md md:sticky md:top-0 md:flex",
        rail ? "w-sidebar-rail" : "w-sidebar",
      )}
    >
      <Link
        href="/home"
        className={cn("mx-2 mb-2 mt-3 flex items-center gap-2.5 rounded-[var(--radius-md)] py-2", FOCUS, rail ? "justify-center px-0" : "px-3")}
        aria-label={rail ? "Vatra" : undefined}
      >
        <BrandMark />
        <AnimatePresence initial={false}>
          {!rail && (
            <m.div key="brand" {...FADE} className="min-w-0 leading-tight">
              <div className="font-display text-lg font-bold tracking-[-0.045em]">Vatra</div>
              <div className="truncate text-xs text-fg-muted" title={t("brand.tagline")}>{t("brand.tagline")}</div>
            </m.div>
          )}
        </AnimatePresence>
      </Link>

      <nav aria-label={t("sidebar.label")} className={cn("min-h-0 flex-1 overflow-y-auto pb-3 [scrollbar-width:thin]", rail ? "px-2" : "px-3")}>
        <div className="flex flex-col gap-0.5">
          {(compact ? NAV_PRIMARY.filter((it) => it.id === "home") : NAV_PRIMARY).map((it) => (
            <NavLink key={it.href} item={it} active={isNavActive(pathname, it)} rail={rail} />
          ))}
        </div>
        {!compact && NAV_GROUPS.map((g) => {
          const hasActive = g.items.some((it) => isNavActive(pathname, it));
          const expanded = rail ? hasActive : open[g.id] || hasActive;
          const bodyId = `nav-group-${g.id}`;
          const groupLabel = t(`groups.${g.id}`);
          return (
            <div key={g.id} className="mt-3">
              {rail ? (
                <div role="separator" aria-label={groupLabel} className="mx-2 mb-1 h-px bg-border" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(g.id)}
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                  aria-label={t("sidebar.toggleGroup", { group: groupLabel })}
                  className={cn("flex min-h-6 w-full items-center justify-between rounded-[var(--radius-md)] px-3 py-1 text-xs font-medium uppercase tracking-wider text-fg-muted transition-colors hover:text-fg", FOCUS)}
                >
                  <span className="truncate" title={groupLabel}>{groupLabel}</span>
                  <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")} aria-hidden />
                </button>
              )}
              <div id={bodyId} hidden={!expanded} className="mt-0.5 flex flex-col gap-0.5">
                {g.items.map((it) => (
                  <NavLink key={it.href} item={it} active={isNavActive(pathname, it)} rail={rail} />
                ))}
              </div>
            </div>
          );
        })}
        {!compact && <div className="mt-3 border-t border-border pt-3">
          <NavLink item={NAV_SETTINGS} active={isNavActive(pathname, NAV_SETTINGS)} rail={rail} />
        </div>}
      </nav>

      <div className={cn("space-y-2 border-t border-border text-xs text-fg-muted", rail ? "p-2" : "p-4")}>
        {!rail && (
          <>
            <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg-muted px-2 py-1.5">
              <span className="truncate" title={t("brand.commandPalette")}>{t("brand.commandPalette")}</span>
              <Kbd className="shrink-0">⌘ K</Kbd>
            </div>
            <div className="truncate" title={t("brand.encryption")}>{t("brand.encryption")}</div>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleRail}
              aria-label={toggleLabel}
              aria-pressed={rail}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-[var(--radius-md)] text-fg-muted transition-colors hover:bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] hover:text-fg",
                FOCUS,
                rail ? "justify-center" : "px-2",
              )}
            >
              <ToggleIcon className="size-4 shrink-0" aria-hidden />
              {!rail && <span className="truncate">{toggleLabel}</span>}
              {!rail && <Kbd className="ml-auto">[</Kbd>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {toggleLabel} · <kbd className="font-mono">[</kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </m.aside>
  );
}
