"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { VatraMark, type VatraMarkState } from "@/components/brand/vatra-mark";
import { LocaleSwitcher } from "@/components/nav/locale-switcher";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import * as React from "react";

type MarkSetter = (state: VatraMarkState) => void;
const AuthMarkContext = React.createContext<MarkSetter>(() => {});

/** Lets a form inside AuthCard drive the brand mark (thinking while pending, error on failure). */
export function useAuthMark(pending: boolean, error: unknown): void {
  const setMark = React.useContext(AuthMarkContext);
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (pending) {
      wasPending.current = true;
      setMark("thinking");
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    if (!error) {
      setMark("static");
      return;
    }
    setMark("error");
    const id = setTimeout(() => setMark("static"), 600);
    return () => clearTimeout(id);
  }, [pending, error, setMark]);
}

export function AuthCard({ title, description, children, footer }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  const t = useTranslations("auth");
  const [mark, setMark] = React.useState<VatraMarkState>("intro");
  return (
    <m.div initial={{ y: 8 }} animate={{ y: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }} className="relative isolate w-full max-w-sm">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-y-20 left-1/2 -z-10 w-[min(42rem,100vw)] -translate-x-1/2 bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-primary)_16%,transparent),color-mix(in_oklch,var(--color-lit)_6%,transparent)_55%,transparent)] blur-2xl"
      />
      <div className="surface space-y-6 p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <VatraMark size={44} state={mark} label={t("brand.name")} className="text-fg" />
          <div className="min-w-0 leading-tight">
            <div className="font-display text-lg font-bold tracking-[-0.045em]" aria-hidden>
              {t("brand.name")}
            </div>
            <div className="text-balance text-xs text-fg-muted">{t("brand.tagline")}</div>
          </div>
        </div>
        <div className="space-y-1">
          <h1 className="text-balance font-display text-xl font-semibold tracking-[-0.01em]">{title}</h1>
          {description && <p className="text-pretty text-sm text-fg-muted">{description}</p>}
        </div>
        <AuthMarkContext.Provider value={setMark}>{children}</AuthMarkContext.Provider>
        {footer && <div className="text-center text-xs text-fg-muted">{footer}</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
        <ThemeToggle />
        <LocaleSwitcher />
      </div>
    </m.div>
  );
}

function ThemeToggle() {
  const t = useTranslations("auth.theme");
  const { update } = useAppearance();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  const label = dark ? t("toLight") : t("toDark");
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={() => update({ theme: dark ? "light" : "dark" })}>
      {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </Button>
  );
}

export function AuthDivider() {
  const t = useTranslations("auth");
  return (
    <div className="flex items-center gap-3 text-2xs uppercase tracking-wider text-fg-muted" role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span>{t("or")}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
