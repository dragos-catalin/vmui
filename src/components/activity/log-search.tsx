"use client";

import { Badge, Button, EmptyState, Input } from "@/components/ui";
import type { LogSearchFacets, LogSearchRow } from "@/server/queries/logs";
import { FileText, Search, X } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

export interface LogSearchProps {
  rows: LogSearchRow[];
  total: number;
  facets: LogSearchFacets;
  matched: boolean;
  query: { q: string; status?: string; action?: string; account?: string };
  accountNames: Record<string, string>;
  pageSize: number;
}

function buildHref(base: LogSearchProps["query"], patch: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = { ...base, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `/logs?${s}` : "/logs";
}

export function LogSearch({ rows, total, facets, matched, query, accountNames, pageSize }: LogSearchProps) {
  const t = useTranslations("observe.logs");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [q, setQ] = React.useState(query.q);
  const [pending, start] = React.useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(() => router.push(buildHref(query, { q, cursor: undefined })));
  };

  const facetGroups: { key: "status" | "action" | "account"; label: string; items: { value: string; count: number }[]; current: string | undefined }[] = [
    { key: "status", label: t("facets.status"), items: facets.status, current: query.status },
    { key: "action", label: t("facets.action"), items: facets.action, current: query.action },
    { key: "account", label: t("facets.account"), items: facets.account, current: query.account },
  ];
  const hasFilters = Boolean(query.q || query.status || query.action || query.account);
  const lastId = rows.at(-1)?.id;

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("placeholder")} aria-label={t("placeholder")} className="pl-8" />
        </div>
        <Button type="submit" loading={pending}>
          {tc("search")}
        </Button>
        {hasFilters && (
          <Button variant="ghost" asChild>
            <Link href="/logs">
              <X className="size-4" aria-hidden /> {tc("clear")}
            </Link>
          </Button>
        )}
      </form>

      <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-4 text-sm" aria-label={t("facets.title")}>
          {facetGroups.map((g) => (
            <section key={g.key}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{g.label}</h3>
              {g.items.length === 0 ? (
                <p className="text-xs text-fg-muted">—</p>
              ) : (
                <ul className="space-y-0.5">
                  {g.items.map((it) => {
                    const active = g.current === it.value;
                    const label = g.key === "account" ? (accountNames[it.value] ?? it.value.slice(0, 8)) : it.value;
                    return (
                      <li key={it.value}>
                        <Link
                          href={buildHref(query, { [g.key]: active ? undefined : it.value, cursor: undefined })}
                          aria-current={active ? "true" : undefined}
                          className={`flex min-h-9 items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 text-xs transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                            active ? "bg-bg-muted font-semibold text-fg" : "text-fg-muted"
                          }`}
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          <span className="shrink-0 tabular-nums">{format.number(it.count)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </aside>

        <m.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          aria-label={t("results")}
          className="surface min-w-0 overflow-hidden font-mono text-xs"
        >
          {rows.length === 0 ? (
            <div className="p-3">
              <EmptyState illustration="search" compact icon={<FileText />} title={t("empty.title")} description={t("empty.description")} />
            </div>
          ) : (
            <ol className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.id} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-baseline">
                  <time dateTime={r.createdAt.toISOString()} className="whitespace-nowrap text-fg-muted" title={r.createdAt.toISOString()}>
                    {format.dateTime(r.createdAt, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold text-fg">{r.action}</span>
                      <span className="min-w-0 truncate text-fg-muted">{r.target}</span>
                    </div>
                    {matched && r.snippet ? (
                      <p
                        className="line-clamp-2 text-fg-muted [&>mark]:rounded-[2px] [&>mark]:bg-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] [&>mark]:text-fg"
                        dangerouslySetInnerHTML={{ __html: r.snippet }}
                      />
                    ) : (
                      r.message && <p className="line-clamp-2 text-fg-muted">{r.message}</p>
                    )}
                  </div>
                  <Badge variant={r.status === "ok" ? "success" : "danger"} className="justify-self-start sm:justify-self-end">
                    {r.status}
                  </Badge>
                </li>
              ))}
            </ol>
          )}
          {rows.length === pageSize && lastId !== undefined && (
            <div className="border-t border-border p-2 text-center">
              <Button variant="ghost" size="sm" asChild>
                <Link href={buildHref(query, { cursor: String(lastId) })}>{t("loadOlder")}</Link>
              </Button>
            </div>
          )}
        </m.section>
      </div>
      <p className="text-xs text-fg-muted">{t("matches", { count: total })}</p>
    </div>
  );
}
