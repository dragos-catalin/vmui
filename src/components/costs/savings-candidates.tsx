"use client";

import { ProviderTile } from "@/components/cloud/provider-tile";
import { Badge } from "@/components/ui";
import { HOURS_PER_MONTH } from "@/lib/utils";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMoney } from "./use-money";

export interface IdleCandidate {
  id: string;
  name: string | null;
  provider: string;
  instanceType: string | null;
  hourly: number;
}

export interface SpotCandidate {
  id: string;
  name: string | null;
  provider: string;
  instanceType: string | null;
  monthlySavingsUsd: number;
  discountFactor: number;
}

const MAX_ANIMATED = 12;

function entrance(i: number) {
  return i < MAX_ANIMATED
    ? { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2, delay: i * 0.03 } }
    : {};
}

function CandidateCard({
  index,
  id,
  name,
  provider,
  instanceType,
  primary,
  secondary,
  tone,
}: {
  index: number;
  id: string;
  name: string | null;
  provider: string;
  instanceType: string | null;
  primary: string;
  secondary: string;
  tone: "default" | "success";
}) {
  return (
    <m.li {...entrance(index)}>
      <Link
        href={`/instances/${encodeURIComponent(id)}`}
        className="surface card-hover flex min-h-14 items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ProviderTile provider={provider} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name ?? id}</span>
          {instanceType && <span className="block truncate font-mono text-xs text-muted">{instanceType}</span>}
        </span>
        <span className="shrink-0 text-right">
          <span className={tone === "success" ? "block text-sm font-semibold tabular-nums text-success" : "block text-sm font-semibold tabular-nums"}>
            {primary}
          </span>
          <span className="block text-xs tabular-nums text-muted">{secondary}</span>
        </span>
      </Link>
    </m.li>
  );
}

export function SavingsCandidates({ idle, spot }: { idle: IdleCandidate[]; spot: SpotCandidate[] }) {
  const t = useTranslations("cloud.costs.savings");
  const tc = useTranslations("cloud.costs");
  const { usd, usdRate } = useMoney();
  const spotTotal = spot.reduce((s, c) => s + c.monthlySavingsUsd, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">{t("idleTitle")}</h3>
        {idle.length === 0 ? (
          <p className="text-xs text-muted">{t("idleEmpty")}</p>
        ) : (
          <ul className="grid gap-2">
            {idle.map((c, i) => (
              <CandidateCard
                key={c.id}
                index={i}
                id={c.id}
                name={c.name}
                provider={c.provider}
                instanceType={c.instanceType}
                primary={tc("perHour", { amount: usdRate(c.hourly) })}
                secondary={tc("perMonth", { amount: usd(c.hourly * HOURS_PER_MONTH) })}
                tone="default"
              />
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
          {t("spotTitle")}
          {spotTotal > 0 && <Badge variant="success">{t("upTo", { amount: usd(spotTotal) })}</Badge>}
        </h3>
        {spot.length === 0 ? (
          <p className="text-xs text-muted">{t("spotEmpty")}</p>
        ) : (
          <ul className="grid gap-2">
            {spot.map((c, i) => (
              <CandidateCard
                key={c.id}
                index={i + idle.length}
                id={c.id}
                name={c.name}
                provider={c.provider}
                instanceType={c.instanceType}
                primary={t("saveMonthly", { amount: usd(c.monthlySavingsUsd) })}
                secondary={t("spotDiscount", { pct: Math.round(c.discountFactor * 100) })}
                tone="success"
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
