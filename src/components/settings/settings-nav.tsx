"use client";

import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Database, KeyRound, Plug, Settings2, ShieldCheck, Users, Workflow, type LucideIcon } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { SETTINGS_HUB_SECTIONS, type SettingsHubSection } from "./sections";

const ICON: Record<SettingsHubSection, LucideIcon> = {
  general: Settings2,
  security: ShieldCheck,
  users: Users,
  access: KeyRound,
  automation: Workflow,
  integrations: Plug,
  data: Database,
};

export function SettingsNav({ value, onChange }: { value: SettingsHubSection; onChange: (s: SettingsHubSection) => void }) {
  const t = useTranslations("settings.nav");
  return (
    <nav
      aria-label={t("label")}
      className="-mx-4 min-w-0 px-4 sm:mx-0 sm:px-0 lg:sticky lg:top-20"
    >
      <ScrollFade label={t("label")} activeKey={value} className="lg:overflow-visible" innerClassName="lg:w-auto">
      <ul className="flex snap-x snap-mandatory gap-1 lg:flex-col">
        {SETTINGS_HUB_SECTIONS.map((id) => {
          const Icon = ICON[id];
          const active = id === value;
          const title = t(`${id}.title`);
          const hint = t(`${id}.hint`);
          return (
            <li key={id} className="snap-start">
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={active ? "page" : undefined}
                title={hint}
                className={cn(
                  "relative flex min-h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-[var(--radius-md)] px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  active ? "font-medium text-fg" : "text-fg-muted hover:bg-bg-muted hover:text-fg",
                )}
              >
                {active && (
                  <m.span
                    layoutId="settings-nav-active"
                    aria-hidden
                    className="absolute inset-0 rounded-[var(--radius-md)] bg-surface shadow-sm"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <Icon className="relative size-4 shrink-0" aria-hidden />
                <span className="relative min-w-0">
                  <span className="block truncate">{title}</span>
                  <span className="hidden truncate text-xs font-normal text-fg-muted lg:block">{hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      </ScrollFade>
    </nav>
  );
}
