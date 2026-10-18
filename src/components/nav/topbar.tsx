"use client";

import { AppearanceSwitcher } from "@/components/appearance/appearance-switcher";
import { LocaleSwitcher } from "@/components/nav/locale-switcher";
import { NotificationsBell } from "@/components/nav/notifications-bell";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { syncAllAccounts } from "@/server/actions/instances";
import { Moon, Plus, RefreshCw, Search, Sun } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { currentNavItem } from "./nav-model";
import { getPaletteOpen, openCommandPalette, PALETTE_LAYOUT_ID, subscribePaletteOpen } from "./shell-events";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Search button that the command palette grows out of (shared Motion layoutId). */
function PaletteTrigger() {
  const t = useTranslations("shell");
  const open = useSyncExternalStore(subscribePaletteOpen, getPaletteOpen, () => false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label={t("topbar.search")}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-keyshortcuts="Control+K Meta+K"
          className={`relative isolate inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] px-2 text-sm text-fg-muted transition-colors hover:text-fg sm:h-9 md:w-56 md:justify-start md:px-3 ${FOCUS}`}
        >
          {/* The morph layer: unmounted while the palette owns the layoutId, so Motion animates between them. */}
          {!open && (
            <m.span
              layoutId={PALETTE_LAYOUT_ID}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              style={{ borderRadius: 12 }}
              className="absolute inset-0 -z-10 hidden border border-border bg-bg-muted md:block"
              aria-hidden
            />
          )}
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden flex-1 truncate text-left md:inline">{t("topbar.searchHint")}</span>
          <Kbd className="hidden md:inline-flex">⌘K</Kbd>
        </button>
      </TooltipTrigger>
      <TooltipContent className="md:hidden">{t("brand.commandPalette")}</TooltipContent>
    </Tooltip>
  );
}

export function Topbar({ user, compact = false }: { user?: ReactNode; compact?: boolean }) {
  const t = useTranslations("nav");
  const tShell = useTranslations("shell");
  const pathname = usePathname();
  const current = currentNavItem(pathname);
  const { resolvedTheme, setTheme } = useTheme();
  const [pending, start] = useTransition();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function syncNow() {
    start(async () => {
      try {
        const r = await syncAllAccounts();
        toast.success(t("synced", { accounts: r.accounts, instances: r.instances }));
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("syncFailed"));
      }
    });
  }

  const currentLabel = current ? tShell(`items.${current.id}` as Parameters<typeof tShell>[0]) : null;

  return (
    <header
      data-vmui-topbar
      className="sticky top-0 z-[var(--z-topbar)] border-b border-border bg-[color-mix(in_oklch,var(--color-bg)_70%,transparent)] pt-[env(safe-area-inset-top)] backdrop-blur-md"
    >
      <div className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6 lg:px-10">
        <nav aria-label={t("controlPlane")} className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
          <span className="hidden truncate sm:inline">{t("controlPlane")}</span>
          {current && currentLabel && (
            <>
              <span className="hidden opacity-40 sm:inline" aria-hidden>
                /
              </span>
              <span className="flex min-w-0 items-center gap-1.5 font-medium text-fg" aria-current="page">
                <current.icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate" title={currentLabel}>
                  {currentLabel}
                </span>
              </span>
            </>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
          <PaletteTrigger />

          <NotificationsBell />

          {/* Below sm the locale + theme controls live in the user menu (SH-41). */}
          <div className={user ? "hidden sm:contents" : "contents"}>
            <LocaleSwitcher />
          </div>

          <AppearanceSwitcher />

          {!compact && (
            <div className="hidden sm:block">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={syncNow} disabled={pending} aria-label={t("syncNow")}>
                    <RefreshCw className={pending ? "size-4 motion-safe:animate-spin" : "size-4"} aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("syncAll")}</TooltipContent>
              </Tooltip>
            </div>
          )}

          <div className={user ? "hidden sm:block" : undefined}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                  aria-label={t("toggleTheme")}
                  suppressHydrationWarning
                >
                  {mounted ? (
                    resolvedTheme === "dark" ? (
                      <Sun className="size-4" aria-hidden />
                    ) : (
                      <Moon className="size-4" aria-hidden />
                    )
                  ) : (
                    <Sun className="size-4 opacity-0" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("toggleTheme")}</TooltipContent>
            </Tooltip>
          </div>

          {!compact && (
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link href="/instances/new" aria-label={t("newInstance")}>
                <Plus className="size-4" aria-hidden /> <span className="hidden md:inline">{t("newInstance")}</span>
              </Link>
            </Button>
          )}
          {user && <div className="ml-0.5 border-l border-border pl-1.5 sm:ml-1 sm:pl-3">{user}</div>}
        </div>
      </div>
    </header>
  );
}
