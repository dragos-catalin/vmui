"use client";

import type { DonutDatum } from "@/components/charts";
import { DonutCard } from "@/components/monitoring/lazy-charts";
import { Badge, Button, DataTable, EmptyState, Field, PageSection, Stat, StatGrid, ToggleGroup, sortableHeader, type ColumnDef, type StatTone, type ToggleOption } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { runCisCheckAction } from "@/server/actions/cis";
import { Play, ShieldCheck } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";

export interface CisInstanceOption {
  id: string;
  accountId: string;
  providerInstanceId: string;
  label: string;
}

export interface CisResultRow {
  id: string;
  checkId: string;
  title: string;
  result: "pass" | "fail" | "skip" | "error";
  evidence: string | null;
  ranAt: Date;
}

type Filter = "all" | "failing" | "passing";

const RESULT_VARIANT: Record<CisResultRow["result"], "success" | "danger" | "warning" | "muted"> = {
  pass: "success",
  fail: "danger",
  error: "warning",
  skip: "muted",
};

export function CisWorkspace({ instances, selectedId, results }: { instances: CisInstanceOption[]; selectedId: string | null; results: CisResultRow[] }) {
  const t = useTranslations("govern.cis");
  const format = useFormatter();
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [detail, setDetail] = React.useState<CisResultRow | null>(null);

  const selected = instances.find((i) => i.id === selectedId) ?? null;

  const scan = useAction(
    async (): Promise<ActionResult> => {
      if (!selected) return { ok: false, error: "common.error" };
      const r = await runCisCheckAction({ accountId: selected.accountId, providerInstanceId: selected.providerInstanceId });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("scanned") },
  );

  const summary = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const r of results) summary[r.result] += 1;
  const total = results.length;
  const score = total === 0 ? 0 : Math.round((summary.pass / total) * 100);
  const scoreTone: StatTone = total === 0 ? "default" : score === 100 ? "success" : score >= 70 ? "warning" : "danger";

  const filtered = results.filter((r) => (filter === "all" ? true : filter === "failing" ? r.result === "fail" || r.result === "error" : r.result === "pass"));
  const donut = (
    [
    { name: t("result.pass"), value: summary.pass, tone: "success" },
    { name: t("result.fail"), value: summary.fail, tone: "danger" },
    { name: t("result.error"), value: summary.error, tone: "warning" },
    { name: t("result.skip"), value: summary.skip, tone: "info" },
    ] satisfies DonutDatum[]
  ).filter((d) => d.value > 0);

  const filterOptions: readonly ToggleOption<Filter>[] = [
    { value: "all", label: t("filter.all") },
    { value: "failing", label: t("filter.failing") },
    { value: "passing", label: t("filter.passing") },
  ];

  const columns = React.useMemo<ColumnDef<CisResultRow, unknown>[]>(
    () => [
      { accessorKey: "checkId", header: sortableHeader(t("columns.check")), cell: ({ row }) => <code className="font-mono text-xs">{row.original.checkId}</code> },
      { accessorKey: "title", header: sortableHeader(t("columns.name")), cell: ({ row }) => <span className="font-medium">{row.original.title}</span> },
      {
        accessorKey: "result",
        header: sortableHeader(t("columns.result")),
        cell: ({ row }) => <Badge variant={RESULT_VARIANT[row.original.result]}>{t(`result.${row.original.result}`)}</Badge>,
      },
      {
        accessorKey: "evidence",
        header: t("columns.evidence"),
        enableSorting: false,
        cell: ({ row }) => <span className="block max-w-[28rem] truncate font-mono text-xs text-fg-muted" title={row.original.evidence ?? undefined}>{row.original.evidence ?? ""}</span>,
      },
    ],
    [t],
  );

  return (
    <>
      <PageSection title={t("instance")}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("instance")} className="w-full sm:max-w-md">
            <Select value={selectedId ?? ""} onValueChange={(v) => router.push(`/cis?instance=${encodeURIComponent(v)}`)} disabled={instances.length === 0}>
              <SelectTrigger aria-label={t("instance")}>
                <SelectValue placeholder={t("instancePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {instances.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button loading={scan.pending} disabled={!selected} onClick={() => void scan.run()}>
            <Play className="size-4" aria-hidden /> {t("run")}
          </Button>
        </div>
      </PageSection>

      {instances.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title={t("noInstances.title")} description={t("noInstances.description")} />
      ) : !selected ? (
        <EmptyState icon={<ShieldCheck />} title={t("pickFirst.title")} description={t("pickFirst.description")} />
      ) : (
        <>
          <StatGrid cols={5}>
            <Stat label={t("stats.score")} value={`${score}%`} tone={scoreTone} hint={t("stats.scoreHint", { pass: summary.pass, total })} icon={<ShieldCheck />} />
            <Stat label={t("stats.pass")} value={summary.pass} tone="success" />
            <Stat label={t("stats.fail")} value={summary.fail} tone={summary.fail ? "danger" : "default"} />
            <Stat label={t("stats.error")} value={summary.error} tone={summary.error ? "warning" : "default"} />
            <Stat label={t("stats.skip")} value={summary.skip} />
          </StatGrid>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <PageSection title={t("columns.check")} action={<ToggleGroup size="sm" value={filter} onValueChange={setFilter} options={filterOptions} aria-label={t("filter.label")} />}>
              <DataTable
                columns={columns}
                data={filtered}
                dense
                searchable={results.length > 8}
                getRowId={(r) => r.id}
                onRowClick={setDetail}
                emptyState={<EmptyState compact icon={<ShieldCheck />} title={t("empty.title")} description={t("empty.description")} />}
              />
            </PageSection>

            <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
              <DonutCard title={t("donut.title")} ariaLabel={t("donut.ariaLabel")} total={`${score}%`} totalLabel={t("donut.total")} data={donut} />
            </m.div>
          </div>
        </>
      )}

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        {detail && (
          <SheetContent title={`${detail.checkId} · ${detail.title}`} description={`${t("sheet.ranAt")}: ${format.dateTime(new Date(detail.ranAt), { dateStyle: "medium", timeStyle: "short" })}`}>
            <div className="space-y-5 text-sm">
              <Badge variant={RESULT_VARIANT[detail.result]}>{t(`result.${detail.result}`)}</Badge>
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{t("sheet.evidence")}</h3>
                {detail.evidence ? (
                  <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-border bg-surface-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">{detail.evidence}</pre>
                ) : (
                  <p className="text-fg-muted">{t("sheet.noEvidence")}</p>
                )}
              </section>
              {detail.result !== "pass" && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{t("sheet.remediation")}</h3>
                  <ol className="list-decimal space-y-1.5 pl-5 text-fg-muted marker:text-fg-soft">
                    {(["1", "2", "3"] as const).map((n) => (
                      <li key={n}>{t(`sheet.steps.${n}`)}</li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
