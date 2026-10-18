"use client";

import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";

export type ProviderStatusState = "ok" | "incident" | "unknown";

export interface ProviderStatusItem {
  id: string;
  label: string;
  url: string;
  state: ProviderStatusState;
  latencyMs: number | null;
}

const DOT: Record<ProviderStatusState, string> = {
  ok: "bg-success",
  incident: "bg-danger",
  unknown: "bg-fg-muted",
};

const STATE_TEXT: Record<ProviderStatusState, string> = {
  ok: "text-success",
  incident: "text-danger",
  unknown: "text-muted",
};

export function ProviderStatusGrid({ statuses }: { statuses: ProviderStatusItem[] }) {
  const t = useTranslations("cloud.providerStatus");
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
      {statuses.map((s, i) => (
        <m.li
          key={s.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: Math.min(i, 11) * 0.03 }}
        >
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("openPage", { label: s.label })}
            className="surface card-hover flex min-h-[4.5rem] items-center gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className={cn("size-2.5 shrink-0 rounded-full pulse-dot", DOT[s.state])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.label}</span>
              <span className="block text-xs text-muted">
                <span className={STATE_TEXT[s.state]}>{t(`state.${s.state}`)}</span>
                {s.latencyMs !== null && <span className="tabular-nums"> · {t("latency", { ms: s.latencyMs })}</span>}
              </span>
            </span>
            <ExternalLink className="size-4 shrink-0 text-muted" aria-hidden />
          </a>
        </m.li>
      ))}
    </ul>
  );
}
