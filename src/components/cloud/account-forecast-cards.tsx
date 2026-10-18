"use client";

import { utilisationTone } from "@/components/cloud/tag-budgets-table";
import { EmptyState, Progress } from "@/components/ui";
import { Sparkline } from "@/components/ui/sparkline";
import { LineChart } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";

export interface AccountForecastItem {
  accountId: string;
  accountName: string;
  daily: number[];
  projected30dUsd: number;
  slopePerDay: number;
  budget: number | null;
}

export function AccountForecastCards({ forecasts }: { forecasts: AccountForecastItem[] }) {
  const t = useTranslations("cloud.accountForecast");
  const format = useFormatter();
  if (forecasts.length === 0) {
    return <EmptyState illustration="costs" icon={<LineChart />} title={t("empty.title")} description={t("empty.description")} />;
  }
  const usd = (n: number, digits = 0) => format.number(n, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {forecasts.map((f, i) => {
        const ratio = f.budget && f.budget > 0 ? f.projected30dUsd / f.budget : null;
        return (
          <m.li
            key={f.accountId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i, 11) * 0.03 }}
            className="surface card-hover flex min-w-0 flex-col gap-3 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{f.accountName}</p>
                <p className="text-xs text-fg-muted tabular-nums">
                  {t("slope", { amount: usd(f.slopePerDay, 2) })}
                  {f.budget != null && f.budget > 0 && <> · {t("cap", { amount: usd(f.budget) })}</>}
                </p>
              </div>
              {f.daily.length >= 2 && <Sparkline values={f.daily} className="shrink-0 text-primary" ariaLabel={t("sparklineAria", { name: f.accountName })} />}
            </div>
            <div>
              <p className="text-2xl font-semibold leading-none tabular-nums">{usd(f.projected30dUsd)}</p>
              <p className="mt-1 text-xs text-fg-muted">{t("projected")}</p>
            </div>
            {ratio != null && f.budget != null && (
              <Progress
                size="sm"
                value={f.projected30dUsd}
                max={f.budget}
                tone={utilisationTone(ratio)}
                label={t("ofBudget")}
              />
            )}
          </m.li>
        );
      })}
    </ul>
  );
}
