"use client";

import { Badge, Progress, type ProgressTone } from "@/components/ui";
import { cn, formatUsd } from "@/lib/utils";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { SpendRow } from "./spend-rows";

function tone(pct: number | null): ProgressTone {
  if (pct == null) return "default";
  if (pct >= 100) return "danger";
  if (pct >= 80) return "warning";
  return "default";
}

export function AccountSpendCards({ rows, compact = false, className }: { rows: SpendRow[]; compact?: boolean; className?: string }) {
  const t = useTranslations("dashboard.spend");
  if (rows.length === 0) return null;

  return (
    <div className={cn(compact ? "flex flex-col gap-2" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4", className)}>
      {rows.map((r, i) => (
        <m.article
          key={r.account.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 8) * 0.035 }}
          aria-label={r.account.name}
          className={cn("surface card-hover min-w-0 space-y-2", compact ? "p-3" : "p-4")}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Link
              href={`/accounts/${encodeURIComponent(r.account.id)}`}
              title={r.account.name}
              className="min-w-0 truncate text-sm font-medium hover:text-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {r.account.name}
            </Link>
            <Badge variant="muted">{r.account.provider}</Badge>
          </div>
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className={cn("font-semibold tabular-nums", compact ? "text-lg" : "text-2xl")}>{formatUsd(r.monthly)}</div>
              <div className="truncate text-2xs text-muted" title={`${t("projected")} · ${t("running", { count: r.runningCount })}`}>
                {t("projected")} · {t("running", { count: r.runningCount })}
              </div>
            </div>
            {r.cap != null && (
              <div className={cn("shrink-0 text-right text-2xs", r.pct != null && r.pct >= 100 ? "text-danger" : r.pct != null && r.pct >= 80 ? "text-warning-text" : "text-muted")}>
                {t("cap", { cap: formatUsd(r.cap) })}
              </div>
            )}
          </div>
          {r.cap != null ? (
            <Progress value={Math.min(100, r.pct ?? 0)} size="sm" tone={tone(r.pct)} label={t("ofBudget", { pct: Math.round(r.pct ?? 0) })} />
          ) : (
            !compact && <p className="text-2xs text-muted">{t("noBudget")}</p>
          )}
        </m.article>
      ))}
    </div>
  );
}
