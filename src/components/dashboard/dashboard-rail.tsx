"use client";

import { useContextRail } from "@/components/nav/context-rail";
import { Badge, Button, PageSection } from "@/components/ui";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";
import { AccountSpendCards } from "./account-spend-cards";
import type { SpendRow } from "./spend-rows";

export interface ActivityRow {
  id: number;
  action: string;
  target: string | null;
  status: "ok" | "error";
  message: string | null;
  createdAt: Date;
}

function RailCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="surface p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-2xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActivityList({ rows, compact }: { rows: ActivityRow[]; compact?: boolean }) {
  const t = useTranslations("dashboard.activity");
  const format = useFormatter();
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => setNow(new Date()), [rows]);
  if (rows.length === 0) return <p className="text-xs text-muted">{t("empty")}</p>;
  return (
    <ol className={compact ? "space-y-1.5" : "grid gap-2 sm:grid-cols-2 xl:grid-cols-3"}>
      {rows.map((r, i) => (
        <m.li
          key={r.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 8) * 0.035 }}
          className="flex min-w-0 items-start gap-2 text-xs"
        >
          <Badge variant={r.status === "ok" ? "success" : "danger"} className="mt-0.5 shrink-0 px-1.5">
            <span className="sr-only">{r.status}</span>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={r.target ? `${r.action} · ${r.target}` : r.action}>
              {r.action}
              {r.target && <span className="font-normal text-muted"> · {r.target}</span>}
            </div>
            {r.message && !compact && (
              <div className="truncate text-muted" title={r.message}>
                {r.message}
              </div>
            )}
            <time dateTime={r.createdAt.toISOString()} className="text-muted" suppressHydrationWarning>
              {now ? format.relativeTime(r.createdAt, now) : format.dateTime(r.createdAt, { hour: "2-digit", minute: "2-digit" })}
            </time>
          </div>
        </m.li>
      ))}
    </ol>
  );
}

export function DashboardRail({ spend, activity }: { spend: SpendRow[]; activity: ActivityRow[] }) {
  const tSpend = useTranslations("dashboard.spend");
  const tAct = useTranslations("dashboard.activity");
  const showSpend = spend.length > 0;

  const rail = useContextRail(
    <>
      {showSpend && (
        <RailCard
          title={tSpend("title")}
          action={
            <Link href="/costs" className="text-2xs text-muted hover:text-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {tSpend("fullView")}
            </Link>
          }
        >
          <AccountSpendCards rows={spend} compact />
        </RailCard>
      )}
      <RailCard
        title={tAct("title")}
        action={
          <Link href="/activity" className="text-2xs text-muted hover:text-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {tAct("viewAll")}
          </Link>
        }
      >
        <ActivityList rows={activity.slice(0, 6)} compact />
      </RailCard>
    </>,
  );

  return (
    <>
      {rail}
      <div className="space-y-6 2xl:hidden">
        {showSpend && (
          <PageSection
            title={tSpend("title")}
            description={tSpend("description")}
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/costs">{tSpend("fullView")}</Link>
              </Button>
            }
          >
            <AccountSpendCards rows={spend} />
          </PageSection>
        )}
        <PageSection
          title={tAct("title")}
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href="/activity">{tAct("viewAll")}</Link>
            </Button>
          }
        >
          <ActivityList rows={activity} />
        </PageSection>
      </div>
    </>
  );
}
