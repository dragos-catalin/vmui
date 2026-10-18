import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, PageSection, PageShell } from "@/components/ui/page-shell";
import { Progress } from "@/components/ui/progress";
import { db } from "@/lib/db";
import { cloudAccounts, instances } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { ArrowRight, Check, Cloud, KeyRound, RefreshCcw, Server, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import "server-only";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("onboarding") };
}

type StepStatus = "done" | "next" | "later";
interface Step {
  id: "masterKey" | "account" | "firstVm";
  icon: React.ReactNode;
  title: string;
  detail: string;
  status: StepStatus;
  cta: string;
  href: string;
}

export default async function OnboardingPage() {
  const t = await getTranslations("auth.onboarding");
  const [accounts, instanceRows] = await Promise.all([
    db.select({ id: cloudAccounts.id }).from(cloudAccounts),
    db.select({ id: instances.id }).from(instances),
  ]);
  const hasMasterKey = !!env.VMUI_MASTER_KEY;
  const hasAccount = accounts.length > 0;
  const hasInstance = instanceRows.length > 0;

  const steps: Step[] = [
    {
      id: "masterKey",
      icon: <KeyRound />,
      title: t("steps.masterKey.title"),
      detail: hasMasterKey ? t("steps.masterKey.done") : t("steps.masterKey.todo"),
      status: hasMasterKey ? "done" : "next",
      cta: t("steps.masterKey.cta"),
      href: "#keygen",
    },
    {
      id: "account",
      icon: <Cloud />,
      title: t("steps.account.title"),
      detail: hasAccount ? t("steps.account.done", { count: accounts.length }) : t("steps.account.todo"),
      status: hasAccount ? "done" : hasMasterKey ? "next" : "later",
      cta: t("steps.account.cta"),
      href: "/accounts/new",
    },
    {
      id: "firstVm",
      icon: <Server />,
      title: t("steps.firstVm.title"),
      detail: hasInstance ? t("steps.firstVm.done", { count: instanceRows.length }) : t("steps.firstVm.todo"),
      status: hasInstance ? "done" : hasAccount ? "next" : "later",
      cta: t("steps.firstVm.cta"),
      href: "/instances/new",
    },
  ];
  const done = steps.filter((s) => s.status === "done").length;

  const optional = [
    { id: "sshKey", title: t("steps.sshKey.title"), detail: t("steps.sshKey.detail"), cta: t("steps.sshKey.cta"), href: "/settings/ssh-keys" },
    { id: "schedule", title: t("steps.schedule.title"), detail: t("steps.schedule.detail"), cta: t("steps.schedule.cta"), href: "/schedules" },
  ];

  const code = (chunks: React.ReactNode) => <code className="rounded-[var(--radius-sm)] bg-bg-muted px-1 py-0.5 font-mono text-2xs text-fg">{chunks}</code>;
  const providerNames = { aws: "AWS", azure: "Azure", gcp: "GCP", scaleway: "Scaleway", kvm: "local-kvm" } as const;

  return (
    <PageShell width="narrow">
      <PageHeader icon={<Sparkles />} title={t("title")} description={t("description")} />

      <Progress value={done} max={steps.length} label={t("progress", { done, total: steps.length })} tone={done === steps.length ? "success" : "default"} />

      <ol className="grid gap-3">
        {steps.map((s, i) => (
          <li key={s.id}>
            <PageSection
              id={s.id}
              className={cn(s.status === "next" && "border-[color-mix(in_oklch,var(--color-primary)_45%,var(--color-border))]")}
              title={
                <span className="flex items-start gap-2">
                  <span className="sr-only">{t("step", { n: i + 1 })}</span>
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums",
                      s.status === "done" ? "bg-success text-success-fg" : s.status === "next" ? "bg-primary text-primary-fg" : "bg-bg-muted text-fg-muted",
                    )}
                    aria-hidden
                  >
                    {s.status === "done" ? <Check className="size-3.5" aria-hidden /> : i + 1}
                  </span>
                  <span className="min-w-0 pt-0.5 leading-snug">
                    {s.title}{" "}
                    <span className="ml-1 inline-flex align-middle">
                      {s.status === "done" && <Badge variant="success">{t("status.done")}</Badge>}
                      {s.status === "next" && <Badge variant="info">{t("status.next")}</Badge>}
                      {s.status === "later" && <Badge variant="muted">{t("status.later")}</Badge>}
                    </span>
                  </span>
                </span>
              }
              action={
                s.status !== "done" && (
                  <Button asChild size="sm" variant={s.status === "next" ? "primary" : "outline"}>
                    <Link href={s.href}>
                      {s.cta}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  </Button>
                )
              }
            >
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <span className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-bg-muted text-primary [&>svg]:size-4" aria-hidden>
                  {s.icon}
                </span>
                <span className="min-w-0">{s.detail}</span>
              </div>
            </PageSection>
          </li>
        ))}
      </ol>

      <PageSection title={t("optional.title")} description={t("optional.description")}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {optional.map((o) => (
            <li key={o.id} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-lg)] border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{o.title}</p>
                <p className="mt-0.5 text-xs leading-snug text-fg-muted">{o.detail}</p>
              </div>
              <Button asChild size="sm" variant="outline" className="mt-auto self-start">
                <Link href={o.href}>
                  {o.cta}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection id="keygen" title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-primary" aria-hidden />{t("keygen.title")}</span>}>
        <p className="text-xs leading-relaxed text-fg-muted">{t.rich("keygen.body", { code })}</p>
      </PageSection>

      <PageSection title={<span className="flex items-center gap-2"><Cloud className="size-4 text-primary" aria-hidden />{t("providers.title")}</span>}>
        <dl className="divide-y divide-border text-xs leading-relaxed">
          {(["aws", "azure", "gcp", "scaleway", "kvm"] as const).map((p) => (
            <div key={p} className="grid min-w-0 gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[7rem_1fr]">
              <dt className="font-medium text-fg">{providerNames[p]}</dt>
              <dd className="min-w-0 text-fg-muted">{t(`providers.${p}`)}</dd>
            </div>
          ))}
        </dl>
      </PageSection>

      <PageSection title={<span className="flex items-center gap-2"><RefreshCcw className="size-4 text-primary" aria-hidden />{t("background.title")}</span>}>
        <p className="text-xs leading-relaxed text-fg-muted">{t("background.body")}</p>
      </PageSection>
    </PageShell>
  );
}
