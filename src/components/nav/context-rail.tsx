"use client";

import { cn } from "@/lib/utils";
import { History, Zap } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";
import { currentNavItem, isNavActive, NAV_ALL, NAV_PRIMARY, type NavItem } from "./nav-model";
import { RECENT_ROUTES_KEY } from "./shell-events";

const MAX_RECENT = 5;

type RailCtx = { slot: HTMLDivElement | null; setSlot: (el: HTMLDivElement | null) => void };
const Ctx = React.createContext<RailCtx | null>(null);

export function ContextRailProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  const value = React.useMemo(() => ({ slot, setSlot }), [slot]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Portals `node` into the context rail while the caller is mounted. No-op when the rail is not rendered. */
export function useContextRail(node: React.ReactNode): React.ReactPortal | null {
  const ctx = React.useContext(Ctx);
  if (!ctx?.slot) return null;
  return createPortal(node, ctx.slot);
}

export function RailCard({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("surface p-4 sm:p-5", className)}>
      <h2 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-muted">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function ClockCard() {
  const t = useTranslations("shell.rail");
  const format = useFormatter();
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    };
    id = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(id);
  }, []);
  return (
    <RailCard title={t("clock")}>
      <time dateTime={now?.toISOString()} className="block text-3xl font-semibold tabular-nums tracking-tight" suppressHydrationWarning>
        {now ? format.dateTime(now, { hour: "2-digit", minute: "2-digit" }) : "--:--"}
      </time>
      <div className="mt-0.5 text-sm text-muted" suppressHydrationWarning>
        {now ? format.dateTime(now, { weekday: "long", day: "numeric", month: "long" }) : ""}
      </div>
    </RailCard>
  );
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ROUTES_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function useRecentRoutes(pathname: string): string[] {
  const [recent, setRecent] = React.useState<string[]>([]);
  React.useEffect(() => {
    const item = currentNavItem(pathname);
    const prev = readRecent();
    if (!item) {
      setRecent(prev);
      return;
    }
    const next = [item.href, ...prev.filter((h) => h !== item.href)].slice(0, MAX_RECENT);
    try {
      window.localStorage.setItem(RECENT_ROUTES_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    setRecent(next);
  }, [pathname]);
  return recent;
}

function QuickLink({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active ? "bg-[color-mix(in_oklch,var(--color-primary)_14%,transparent)] text-fg" : "text-fg-muted hover:bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] hover:text-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary-text")} aria-hidden />
      <span className="truncate" title={label}>{label}</span>
    </Link>
  );
}

function QuickLinksCard({ pathname }: { pathname: string }) {
  const t = useTranslations("shell");
  const recent = useRecentRoutes(pathname);
  const label = (id: string) => t(`items.${id}` as Parameters<typeof t>[0]);
  const primaryHrefs = new Set(NAV_PRIMARY.map((it) => it.href));
  const recentItems = recent
    .filter((h) => !primaryHrefs.has(h) && h !== pathname)
    .map((h) => NAV_ALL.find((it) => it.href === h))
    .filter((it): it is NavItem => !!it);
  return (
    <RailCard title={t("rail.quickLinks")} icon={<Zap className="size-3" aria-hidden />}>
      <div className="flex flex-col gap-0.5">
        {NAV_PRIMARY.map((it) => (
          <QuickLink key={it.href} item={it} active={isNavActive(pathname, it)} label={label(it.id)} />
        ))}
      </div>
      <h3 className="mb-1 mt-3 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-muted">
        <History className="size-3" aria-hidden />
        {t("rail.recent")}
      </h3>
      {recentItems.length === 0 ? (
        <p className="px-2 text-xs text-muted">{t("rail.noRecent")}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {recentItems.map((it) => (
            <QuickLink key={it.href} item={it} active={false} label={label(it.id)} />
          ))}
        </div>
      )}
    </RailCard>
  );
}

export function ContextRailHost({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("shell.rail");
  const pathname = usePathname();
  const ctx = React.useContext(Ctx);
  if (compact) return null;
  return (
    <aside data-vmui-rail aria-label={t("label")} className="hidden w-rail shrink-0 pl-6 2xl:block">
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top)+1rem)] flex max-h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-2rem)] flex-col gap-4 overflow-y-auto [scrollbar-width:thin]">
        <ClockCard />
        <QuickLinksCard pathname={pathname} />
        <div ref={ctx?.setSlot ?? null} className="flex flex-col gap-4 empty:hidden" />
      </div>
    </aside>
  );
}
