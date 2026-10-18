"use client";

import { BarChartCard } from "@/components/monitoring/lazy-charts";
import { EmptyState, PageSection, ToggleGroup, type ToggleOption } from "@/components/ui";
import { AlertTriangle, Coffee } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export interface DigestErrorItem {
  id: number;
  action: string;
  target: string | null;
  message: string | null;
  createdAt: number;
}

const WINDOWS = ["1", "6", "24", "168"] as const;

export function DigestView({ hours, top, errors }: { hours: number; top: { action: string; count: number }[]; errors: DigestErrorItem[] }) {
  const t = useTranslations("observe.digest");
  const format = useFormatter();
  const router = useRouter();
  const options: ToggleOption<string>[] = WINDOWS.map((h) => ({ value: h, label: t(`window.${h}`) }));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ToggleGroup value={String(hours)} onValueChange={(v) => router.push(`/digest?hours=${v}`)} options={options} size="sm" aria-label={t("windowLabel")} />
      </div>

      <BarChartCard
        title={t("topActions")}
        description={t("topActionsHint")}
        data={top}
        x="action"
        series={[{ key: "count", label: t("stats.events"), tone: "primary" }]}
        ariaLabel={t("topActionsAria")}
        emptyTitle={t("noActivity")}
        height={Math.max(160, 28 * top.length + 60)}
        xFormatter={(v) => String(v).replace(/^[a-z-]+\./, "")}
      />

      <PageSection title={t("recentErrors")}>
        {errors.length === 0 ? (
          <EmptyState compact icon={<Coffee />} title={t("noErrors")} description={t("noErrorsHint")} />
        ) : (
          <ul className="divide-y divide-border">
            {errors.map((e, i) => (
              <m.li
                key={e.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                className="py-2"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden />
                  <span className="font-mono text-xs">{e.action}</span>
                  <span className="min-w-0 truncate text-xs text-fg-muted">{e.target}</span>
                  <time dateTime={new Date(e.createdAt).toISOString()} className="ml-auto font-mono text-[11px] tabular-nums text-fg-muted">
                    {format.dateTime(new Date(e.createdAt), { timeStyle: "medium" })}
                  </time>
                </div>
                {e.message && <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{e.message}</p>}
              </m.li>
            ))}
          </ul>
        )}
      </PageSection>
    </div>
  );
}
