"use client";

import { DonutCard } from "@/components/monitoring/lazy-charts";
import { Badge, Button, DataTable, EmptyState, PageSection, Stat, StatGrid, ToggleGroup, sortableHeader, type ColumnDef, type StatTone, type ToggleOption } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { revokeOpenWorldRuleAction } from "@/server/actions/compliance-fix";
import { deleteOrphanResourceAction } from "@/server/actions/orphan-cleanup";
import type { Finding, FindingKind, Severity } from "@/server/queries/compliance";
import { ShieldCheck, Trash2, Wrench } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";

export const CONTROL_KINDS: readonly FindingKind[] = [
  "ssh-open-world",
  "rdp-open-world",
  "any-open-world",
  "public-bucket",
  "unencrypted-volume",
  "stopped-but-billable",
  "long-stopped",
  "missing-required-tags",
  "orphan-snapshot",
  "orphan-volume",
  "orphan-elastic-ip",
];

const KIND_SEVERITY: Record<FindingKind, Severity> = {
  "ssh-open-world": "critical",
  "rdp-open-world": "critical",
  "any-open-world": "high",
  "public-bucket": "high",
  "unencrypted-volume": "high",
  "stopped-but-billable": "low",
  "long-stopped": "medium",
  "missing-required-tags": "medium",
  "orphan-snapshot": "low",
  "orphan-volume": "low",
  "orphan-elastic-ip": "medium",
};

const SEVERITY_VARIANT: Record<Severity, "danger" | "warning" | "info" | "muted"> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "muted",
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ORPHAN_KINDS = new Set<FindingKind>(["orphan-volume", "orphan-snapshot", "orphan-elastic-ip"]);

interface ControlRow {
  kind: FindingKind;
  severity: Severity;
  findings: Finding[];
}

type Filter = "all" | "failing" | "passing";

export function ComplianceWorkspace({ findings }: { findings: Finding[] }) {
  const t = useTranslations("govern.compliance");
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [detail, setDetail] = React.useState<FindingKind | null>(null);
  const [scanning, startScan] = React.useTransition();

  const rows = React.useMemo<ControlRow[]>(() => {
    const byKind = new Map<FindingKind, Finding[]>();
    for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
    return CONTROL_KINDS.map((kind) => {
      const list = byKind.get(kind) ?? [];
      const worst = list.reduce<Severity>((acc, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[acc] ? f.severity : acc), KIND_SEVERITY[kind]);
      return { kind, severity: list.length ? worst : KIND_SEVERITY[kind], findings: list };
    }).sort((a, b) => Number(b.findings.length > 0) - Number(a.findings.length > 0) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [findings]);

  const failing = rows.filter((r) => r.findings.length > 0).length;
  const passing = rows.length - failing;
  const score = Math.round((passing / rows.length) * 100);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity] += 1;
  const scoreTone: StatTone = score === 100 ? "success" : score >= 70 ? "warning" : "danger";

  const filtered = rows.filter((r) => (filter === "all" ? true : filter === "failing" ? r.findings.length > 0 : r.findings.length === 0));

  const filterOptions: readonly ToggleOption<Filter>[] = [
    { value: "all", label: t("filter.all") },
    { value: "failing", label: t("filter.failing") },
    { value: "passing", label: t("filter.passing") },
  ];

  const columns = React.useMemo<ColumnDef<ControlRow, unknown>[]>(
    () => [
      {
        id: "control",
        accessorFn: (r) => t(`controls.${r.kind}.title`),
        header: sortableHeader(t("columns.control")),
        cell: ({ row }) => <span className="font-medium">{t(`controls.${row.original.kind}.title`)}</span>,
      },
      {
        id: "severity",
        accessorFn: (r) => SEVERITY_ORDER[r.severity],
        header: sortableHeader(t("columns.severity")),
        cell: ({ row }) => <Badge variant={SEVERITY_VARIANT[row.original.severity]}>{t(`severity.${row.original.severity}`)}</Badge>,
      },
      {
        id: "status",
        accessorFn: (r) => r.findings.length > 0,
        header: sortableHeader(t("columns.status")),
        cell: ({ row }) =>
          row.original.findings.length > 0 ? <Badge variant="danger" dot>{t("status.failing")}</Badge> : <Badge variant="success">{t("status.passing")}</Badge>,
      },
      {
        id: "resources",
        accessorFn: (r) => r.findings.length,
        header: sortableHeader(t("columns.resources")),
        cell: ({ row }) => <span className="tabular-nums text-fg-muted">{row.original.findings.length}</span>,
      },
    ],
    [t],
  );

  const active = detail ? rows.find((r) => r.kind === detail) ?? null : null;

  return (
    <>
      <StatGrid cols={4}>
        <Stat label={t("stats.score")} value={`${score}%`} tone={scoreTone} hint={t("stats.scoreHint", { passing, total: rows.length })} icon={<ShieldCheck />} />
        <Stat label={t("stats.findings")} value={findings.length} tone={findings.length ? "warning" : "success"} />
        <Stat label={t("stats.critical")} value={counts.critical} tone={counts.critical ? "danger" : "default"} hint={t("stats.criticalHint", { high: counts.high, medium: counts.medium, low: counts.low })} />
        <Stat label={t("stats.failing")} value={failing} tone={failing ? "warning" : "success"} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PageSection
          title={t("columns.control")}
          action={
            <>
              <ToggleGroup size="sm" value={filter} onValueChange={setFilter} options={filterOptions} aria-label={t("filter.label")} />
              <Button size="sm" variant="secondary" loading={scanning} onClick={() => startScan(() => router.refresh())}>
                {t("scan")}
              </Button>
            </>
          }
        >
          <DataTable
            columns={columns}
            data={filtered}
            dense
            getRowId={(r) => r.kind}
            onRowClick={(r) => setDetail(r.kind)}
            emptyState={<EmptyState compact icon={<ShieldCheck />} title={t("empty.title")} description={t("empty.description")} />}
          />
        </PageSection>

        <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
          <DonutCard
            title={t("donut.title")}
            ariaLabel={t("donut.ariaLabel")}
            total={`${score}%`}
            totalLabel={t("donut.total")}
            data={[
              { name: t("donut.passing"), value: passing, tone: "success" },
              { name: t("donut.failing"), value: failing, tone: "danger" },
            ]}
          />
        </m.div>
      </div>

      <Sheet open={active !== null} onOpenChange={(open) => !open && setDetail(null)}>
        {active && (
          <SheetContent title={t(`controls.${active.kind}.title`)} description={t("sheet.affectedCount", { count: active.findings.length })}>
            <ControlDetail row={active} />
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}

function ControlDetail({ row }: { row: ControlRow }) {
  const t = useTranslations("govern.compliance");
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={SEVERITY_VARIANT[row.severity]}>{t(`severity.${row.severity}`)}</Badge>
        {row.findings.length > 0 ? <Badge variant="danger" dot>{t("status.failing")}</Badge> : <Badge variant="success">{t("status.passing")}</Badge>}
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{t("sheet.remediation")}</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-fg-muted marker:text-fg-soft">
          {(["1", "2", "3"] as const).map((n) => (
            <li key={n}>{t(`controls.${row.kind}.steps.${n}`)}</li>
          ))}
        </ol>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{t("sheet.affected")}</h3>
        {row.findings.length === 0 ? (
          <p className="text-fg-muted">{t("sheet.clean")}</p>
        ) : (
          <ul className="space-y-2">
            {row.findings.map((f, i) => (
              <m.li
                key={f.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                className="rounded-[var(--radius-md)] border border-border bg-surface-muted p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{f.resourceName}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {f.provider.toUpperCase()} · {f.accountName} · {f.region} · {f.resourceKind}
                    </p>
                    <p className="mt-1 text-xs">{f.message}</p>
                    <code className="mt-1 block truncate font-mono text-[11px] text-fg-soft">{f.externalId}</code>
                  </div>
                  <FindingAction finding={f} />
                </div>
              </m.li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FindingAction({ finding }: { finding: Finding }) {
  const t = useTranslations("govern.compliance");
  const confirm = useConfirm();
  const revoke = useAction(
    async (port: number): Promise<ActionResult> => {
      const r = await revokeOpenWorldRuleAction({ accountId: finding.accountId, groupId: finding.externalId, port });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
  );
  const purge = useAction(async (): Promise<ActionResult> => {
    const r = await deleteOrphanResourceAction({
      accountId: finding.accountId,
      resourceId: `${finding.accountId}:${finding.region}:${finding.resourceKind}:${finding.externalId}`,
    });
    return r.ok ? ok() : { ok: false, error: r.error };
  });

  if (finding.provider !== "aws") return null;

  if (finding.kind === "ssh-open-world" || finding.kind === "rdp-open-world") {
    const port = finding.kind === "ssh-open-world" ? 22 : 3389;
    return (
      <Button
        size="sm"
        variant="outline"
        loading={revoke.pending}
        aria-label={t("fix.revokeLabel", { id: finding.externalId })}
        onClick={async () => {
          const yes = await confirm({ title: t(`controls.${finding.kind}.title`), description: finding.message, tone: "warning", confirmText: t("fix.revoke") });
          if (yes) await revoke.run(port);
        }}
      >
        <Wrench className="size-3.5" aria-hidden /> {t("fix.revoke")}
      </Button>
    );
  }

  if (ORPHAN_KINDS.has(finding.kind)) {
    return (
      <Button
        size="sm"
        variant="outline"
        loading={purge.pending}
        aria-label={t("fix.deleteLabel", { id: finding.externalId })}
        onClick={async () => {
          const yes = await confirm({ title: t(`controls.${finding.kind}.title`), description: finding.message, tone: "danger", confirmText: t("fix.delete"), requireText: finding.externalId });
          if (yes) await purge.run();
        }}
      >
        <Trash2 className="size-3.5 text-danger" aria-hidden /> {t("fix.delete")}
      </Button>
    );
  }
  return null;
}
