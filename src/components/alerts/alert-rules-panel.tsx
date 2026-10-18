"use client";

import { Badge, Button, DataTable, EmptyState, Field, Input, Switch, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import type { AlertChannelRow, AlertRuleRow } from "@/lib/db/schema";
import { createAlertRuleAction, deleteAlertRuleAction, evaluateRulesNowAction, toggleAlertRuleAction } from "@/server/actions/alerts";
import { BellRing, Play, Plus, Trash2 } from "lucide-react";
import * as Mo from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

interface Props {
  rules: AlertRuleRow[];
  channels: AlertChannelRow[];
}

const METRICS = ["cpu", "mem", "disk", "net_in", "net_out", "load1", "uptime"] as const;
const OPS = [">", "<", ">=", "<=", "==", "!="] as const;
type Metric = (typeof METRICS)[number];
type Op = (typeof OPS)[number];
type Severity = "info" | "warning" | "critical";

const SEVERITY_VARIANT: Record<Severity, "info" | "warning" | "danger"> = { info: "info", warning: "warning", critical: "danger" };

interface Expr {
  metric: string;
  op: string;
  threshold: number;
  windowSec: number;
}

function parseExpr(json: string): Expr | null {
  try {
    return JSON.parse(json) as Expr;
  } catch {
    return null;
  }
}

const wrap =
  <A extends unknown[]>(fn: (...a: A) => Promise<{ ok: boolean; error?: string }>) =>
  async (...a: A): Promise<ActionResult> => {
    const r = await fn(...a);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "common.error" };
  };

export function AlertRulesPanel({ rules, channels }: Props) {
  const t = useTranslations("observe.alerts.rules");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);

  const [name, setName] = React.useState("");
  const [severity, setSeverity] = React.useState<Severity>("warning");
  const [metric, setMetric] = React.useState<Metric>("cpu");
  const [op, setOp] = React.useState<Op>(">");
  const [threshold, setThreshold] = React.useState("80");
  const [windowSec, setWindowSec] = React.useState("120");
  const [cooldownSec, setCooldownSec] = React.useState("600");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [template, setTemplate] = React.useState("{{instance}}: {{metric}} = {{value}} (> {{threshold}})");

  const create = useAction(wrap(createAlertRuleAction), {
    success: t("created"),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setPicked(new Set());
    },
  });
  const toggle = useAction(wrap(toggleAlertRuleAction));
  const remove = useAction(wrap(deleteAlertRuleAction), { success: tc("delete") });
  const evaluate = useAction(wrap(evaluateRulesNowAction), { success: t("evaluated") });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.size === 0) {
      toast.error(t("pickChannel"));
      return;
    }
    void create.run({
      name,
      severity,
      enabled: true,
      expression: { metric, op, threshold: Number(threshold), windowSec: Number(windowSec), cooldownSec: Number(cooldownSec) },
      scope: null,
      channelIds: Array.from(picked),
      messageTemplate: template,
    });
  };

  const columns: ColumnDef<AlertRuleRow>[] = React.useMemo(
    () => [
      {
        id: "enabled",
        header: t("columns.enabled"),
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            onCheckedChange={(v) => void toggle.run({ id: row.original.id, enabled: v })}
            aria-label={row.original.enabled ? t("disable") : t("enable")}
          />
        ),
      },
      {
        id: "name",
        header: t("columns.name"),
        cell: ({ row }) => <span className="block max-w-[14rem] truncate font-medium">{row.original.name}</span>,
      },
      {
        id: "severity",
        header: t("columns.severity"),
        cell: ({ row }) => {
          const s = row.original.severity as Severity;
          return <Badge variant={SEVERITY_VARIANT[s] ?? "info"}>{t(`severity.${s}`)}</Badge>;
        },
      },
      {
        id: "expression",
        header: t("columns.expression"),
        cell: ({ row }) => {
          const e = parseExpr(row.original.expressionJson);
          if (!e) return <span className="text-fg-muted">—</span>;
          return (
            <code className="font-mono text-xs text-fg-muted">
              {e.metric} {e.op} {e.threshold} · {e.windowSec}s
            </code>
          );
        },
      },
    ],
    [t, toggle],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" loading={evaluate.pending} onClick={() => void evaluate.run()}>
          <Play className="size-4" aria-hidden /> {t("evaluateNow")}
        </Button>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden /> {t("add")}
        </Button>
      </div>

      <Mo.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
        <DataTable
          columns={columns}
          data={rules}
          dense
          getRowId={(r) => r.id}
          emptyState={
            <EmptyState
              compact
              icon={<BellRing />}
              title={t("empty.title")}
              description={t("empty.description")}
              action={
                <Button size="sm" onClick={() => setOpen(true)}>
                  <Plus className="size-4" aria-hidden /> {t("add")}
                </Button>
              }
            />
          }
          rowActions={(r) => (
            <Button
              size="icon"
              variant="ghost"
              aria-label={tc("delete")}
              className="text-danger"
              loading={remove.pending}
              onClick={async () => {
                if (!(await confirm({ title: t("confirmDelete", { name: r.name }), tone: "danger", confirmText: tc("delete") }))) return;
                void remove.run({ id: r.id });
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        />
      </Mo.div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={t("sheet.title")} description={t("sheet.description")}>
          <form onSubmit={submit} className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("form.name")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
              </Field>
              <Field label={t("form.severity")}>
                <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
                  <SelectTrigger aria-label={t("form.severity")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["info", "warning", "critical"] as const).map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`severity.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("form.metric")}>
                <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
                  <SelectTrigger aria-label={t("form.metric")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRICS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(`metric.${m}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("form.op")}>
                <Select value={op} onValueChange={(v) => setOp(v as Op)}>
                  <SelectTrigger aria-label={t("form.op")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPS.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("form.threshold")}>
                <Input type="number" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} required />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("form.window")} hint={t("form.windowHint")}>
                <Input type="number" min={10} max={3600} value={windowSec} onChange={(e) => setWindowSec(e.target.value)} required />
              </Field>
              <Field label={t("form.cooldown")} hint={t("form.cooldownHint")}>
                <Input type="number" min={0} max={86400} value={cooldownSec} onChange={(e) => setCooldownSec(e.target.value)} />
              </Field>
            </div>
            <Field label={t("form.template")} hint={t("form.templateHint")}>
              <Input value={template} onChange={(e) => setTemplate(e.target.value)} className="font-mono text-xs" maxLength={500} />
            </Field>
            <fieldset>
              <legend className="mb-1.5 block text-xs text-fg-muted">{t("form.channels")}</legend>
              {channels.length === 0 ? (
                <p className="text-xs text-fg-muted">{t("form.noChannels")}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((c) => {
                    const on = picked.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setPicked((s) => {
                            const next = new Set(s);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className={`min-h-10 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          on ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] text-primary" : "border-border bg-surface text-fg-muted hover:text-fg"
                        }`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </fieldset>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" loading={create.pending}>
                {tc("save")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
