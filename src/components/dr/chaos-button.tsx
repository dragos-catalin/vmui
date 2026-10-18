"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { toError } from "@/components/settings/adapt";
import { Alert, Badge, Button, PageHeader, PageSection, PageShell, Progress, Stat, StatGrid } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import type { DrillCheck, DrillResult } from "@/lib/dr-drill";
import { runDrDrillAction } from "@/server/actions/dr";
import { AlertTriangle, ShieldCheck, XCircle, Zap } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type Step = 1 | 2 | 3;

const CHECK_VARIANT: Record<DrillCheck["status"], "success" | "warning" | "danger"> = { pass: "success", warn: "warning", fail: "danger" };
const CHECK_ICON: Record<DrillCheck["status"], typeof ShieldCheck> = { pass: ShieldCheck, warn: AlertTriangle, fail: XCircle };
const CHECK_TEXT: Record<DrillCheck["status"], string> = { pass: "text-success", warn: "text-warning", fail: "text-danger" };

export function ChaosButton() {
  const t = useTranslations("ops.dr");
  const format = useFormatter();
  const confirm = useConfirm();
  const [result, setResult] = useState<DrillResult | null>(null);

  const drill = useAction(
    async (): Promise<ActionResult<DrillResult>> => {
      const r = await runDrDrillAction();
      return r.ok ? ok(r.result) : toError(r);
    },
    {
      refresh: false,
      onSuccess: (r) => {
        setResult(r);
        toast[r.failed > 0 ? "error" : r.warned > 0 ? "warning" : "success"](r.summary);
      },
    },
  );

  const step: Step = drill.pending ? 2 : result ? 3 : 1;

  const start = async () => {
    const yes = await confirm({
      title: t("confirm.title"),
      description: t("confirm.description"),
      tone: "warning",
      confirmText: t("confirm.cta"),
    });
    if (!yes) return;
    setResult(null);
    await drill.run();
  };

  const logLines = useMemo(() => {
    if (!result) return [];
    return [
      `# ${t("log.started", { at: format.dateTime(new Date(result.startedAt), { dateStyle: "medium", timeStyle: "medium" }) })}`,
      ...result.checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name}  —  ${c.detail}`),
      "",
      `# ${result.summary}`,
    ];
  }, [result, t, format]);

  const tone = result ? (result.failed > 0 ? "danger" : result.warned > 0 ? "warning" : "success") : "default";

  return (
    <PageShell width="narrow">
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<Zap />}
        badge={<Badge variant="info">{t("readOnly")}</Badge>}
        actions={
          <Button onClick={() => void start()} loading={drill.pending}>
            <Zap className="size-4" aria-hidden />
            {result ? t("runAgain") : t("run")}
          </Button>
        }
      />

      <Progress value={step} max={3} label={t("progress", { step, total: 3 })} tone={step === 3 ? tone : "default"} />

      <PageSection title={t("steps.scope.title")} description={t("steps.scope.description")}>
        <ul className="grid gap-2 text-sm sm:grid-cols-3">
          {(["backups", "credentials", "gitops"] as const).map((k) => (
            <li key={k} className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border px-3 py-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                <span className="block font-medium">{t(`steps.scope.${k}.title`)}</span>
                <span className="block text-xs text-muted">{t(`steps.scope.${k}.hint`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection
        title={t("steps.run.title")}
        description={t("steps.run.description")}
        action={
          step === 2 ? (
            <Badge variant="info" dot>
              {t("steps.run.running")}
            </Badge>
          ) : step === 3 ? (
            <Badge variant={CHECK_VARIANT[result!.failed > 0 ? "fail" : result!.warned > 0 ? "warn" : "pass"]}>{t("steps.run.done")}</Badge>
          ) : (
            <Badge variant="muted">{t("steps.run.idle")}</Badge>
          )
        }
      >
        {step === 1 && <Alert tone="info">{t("steps.run.hint")}</Alert>}
        {step === 2 && <Progress indeterminate label={t("steps.run.checking")} />}
        {step === 3 && result && (
          <StatGrid cols={3}>
            <Stat label={t("stats.passed")} value={result.passed} tone="success" icon={<ShieldCheck />} />
            <Stat label={t("stats.warned")} value={result.warned} tone={result.warned > 0 ? "warning" : "default"} icon={<AlertTriangle />} />
            <Stat label={t("stats.failed")} value={result.failed} tone={result.failed > 0 ? "danger" : "default"} icon={<XCircle />} />
          </StatGrid>
        )}
      </PageSection>

      {result && (
        <PageSection title={t("steps.results.title")} description={t("steps.results.description", { count: result.totalChecks })}>
          <ul className="space-y-2">
            {result.checks.map((c, i) => {
              const Icon = CHECK_ICON[c.status];
              return (
                <m.li
                  key={`${c.name}-${i}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                  className="flex min-w-0 items-start gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2"
                >
                  <Icon className={`mt-0.5 size-4 shrink-0 ${CHECK_TEXT[c.status]}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      <Badge variant={CHECK_VARIANT[c.status]}>{t(`checkStatus.${c.status}`)}</Badge>
                    </span>
                    <span className="mt-0.5 block break-words text-xs text-muted">{c.detail}</span>
                  </span>
                </m.li>
              );
            })}
          </ul>
          <LogViewer
            className="mt-4"
            title={t("log.title")}
            lines={logLines}
            height="max-h-72"
            autoScroll={false}
            lineTone={(line) => (line.startsWith("FAIL") ? "danger" : line.startsWith("WARN") ? "warning" : line.startsWith("PASS") ? "success" : line.startsWith("#") ? "muted" : undefined)}
          />
        </PageSection>
      )}
    </PageShell>
  );
}
