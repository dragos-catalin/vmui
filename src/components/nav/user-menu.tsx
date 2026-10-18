"use client";

import { Badge } from "@/components/ui/badge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, type Locale } from "@/i18n/config";
import { signOutAction } from "@/server/actions/auth";
import { setLocale } from "@/server/actions/locale";
import { ChevronDown, Languages, LogOut, Moon, Settings, ShieldCheck, Sun, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function UserMenu({
  user,
}: {
  user: { email: string; displayName: string; role: "admin" | "operator" | "viewer" };
}) {
  const t = useTranslations("shell.userMenu");
  const tNav = useTranslations("nav");
  const locale = useLocale() as Locale;
  const nextLocale = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] ?? "en";
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  const [pending, start] = useTransition();
  const initial = (user.displayName.trim()[0] ?? user.email[0] ?? "?").toUpperCase();
  const roleLabel = t(`role.${user.role}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("menu")}
          className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] pl-1 pr-1.5 text-xs transition-colors hover:bg-[color-mix(in_oklch,var(--color-fg)_8%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:bg-[color-mix(in_oklch,var(--color-fg)_8%,transparent)] sm:h-9"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-primary)_20%,transparent)] text-sm font-semibold text-primary-text" aria-hidden>
            {initial}
          </span>
          <span className="hidden max-w-40 truncate font-medium lg:inline" title={user.displayName}>{user.displayName}</span>
          <ChevronDown className="hidden size-3.5 text-fg-muted sm:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60 max-w-[calc(100vw-1rem)]">
        <div className="flex items-start gap-2.5 px-2.5 py-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-primary)_20%,transparent)] text-base font-semibold text-primary-text" aria-hidden>
            {initial}
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium" title={user.displayName}>{user.displayName}</div>
            <div className="truncate text-xs text-fg-muted" title={user.email}>{user.email}</div>
            <Badge variant={user.role === "admin" ? "info" : user.role === "operator" ? "default" : "muted"} className="mt-1.5">
              <ShieldCheck className="size-3" aria-hidden />
              {roleLabel}
            </Badge>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="sr-only">{t("menu")}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="size-4 text-fg-muted" aria-hidden />
            {t("account")}
          </Link>
        </DropdownMenuItem>
        {user.role === "admin" && (
          <DropdownMenuItem asChild>
            <Link href="/home?tab=settings&section=family">
              <Users className="size-4 text-fg-muted" aria-hidden />
              {t("family")}
            </Link>
          </DropdownMenuItem>
        )}
        {/* Below sm the topbar hides these two buttons; they live here instead. */}
        <DropdownMenuSeparator className="sm:hidden" />
        <DropdownMenuItem
          className="sm:hidden"
          disabled={pending}
          onSelect={() =>
            start(async () => {
              await setLocale(nextLocale);
              router.refresh();
            })
          }
        >
          <Languages className="size-4 text-fg-muted" aria-hidden />
          {tNav("switchLanguage", { lang: nextLocale.toUpperCase() })}
        </DropdownMenuItem>
        <DropdownMenuItem className="sm:hidden" onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <Sun className="size-4 text-fg-muted" aria-hidden /> : <Moon className="size-4 text-fg-muted" aria-hidden />}
          {tNav("toggleTheme")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger disabled={pending} onSelect={() => start(() => signOutAction())}>
          <LogOut className="size-4" aria-hidden />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
