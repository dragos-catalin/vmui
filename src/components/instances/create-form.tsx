"use client";

import { Alert, Button, Field, Input, PageSection, Textarea, ToggleGroup } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InstanceTemplate, ProviderId } from "@/lib/providers/types";
import { cn } from "@/lib/utils";
import { createInstanceAction, type CreateInstanceState } from "@/server/actions/instances";
import { Apple, MonitorSmartphone, Server } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PriceEstimate } from "./price-estimate";

const initial: CreateInstanceState = {};
const NO_BOOT_SCRIPT = "__none__";
const code = (c: React.ReactNode) => <code>{c}</code>;

export function CreateInstanceForm({
  accounts,
  templatesByProvider,
  regionsByProvider,
  bootScripts = [],
}: {
  accounts: { id: string; name: string; provider: string; defaultRegion: string | null }[];
  templatesByProvider: Record<ProviderId, InstanceTemplate[]>;
  regionsByProvider: Record<ProviderId, string[]>;
  bootScripts?: { id: string; name: string; kind: string }[];
}) {
  const t = useTranslations("vm.create");
  const [state, action, pending] = useActionState(createInstanceAction, initial);
  const router = useRouter();

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId);
  const providerId = (account?.provider ?? "aws") as ProviderId;

  const templates = templatesByProvider[providerId] ?? [];
  const regions = regionsByProvider[providerId] ?? [];

  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const template = useMemo(() => templates.find((t) => t.id === templateId), [templates, templateId]);
  const [instanceType, setInstanceType] = useState(template?.recommendedTypes[0] ?? "");
  const [region, setRegion] = useState(account?.defaultRegion ?? regions[0] ?? "");
  const [bootScriptId, setBootScriptId] = useState("");

  // When the user switches account → provider may change → reset template/region/type
  useEffect(() => {
    const newTpl = templatesByProvider[providerId]?.[0];
    if (newTpl && newTpl.id !== templateId) setTemplateId(newTpl.id);
    const newRegions = regionsByProvider[providerId] ?? [];
    if (account?.defaultRegion && newRegions.includes(account.defaultRegion)) {
      setRegion(account.defaultRegion);
    } else if (newRegions.length > 0 && !newRegions.includes(region)) {
      setRegion(newRegions[0] ?? "");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (template && !template.recommendedTypes.includes(instanceType)) {
      setInstanceType(template.recommendedTypes[0] ?? "");
    }
  }, [template, instanceType]);

  useEffect(() => {
    if (state.ok && state.instanceId) {
      toast.success(t("launched"));
      router.push("/");
      router.refresh();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, router, t]);

  const sizes = template?.recommendedTypes ?? [];
  const showBootScript = bootScripts.length > 0 && providerId !== "scaleway" && providerId !== "local-kvm";

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="region" value={region} />
      <input type="hidden" name="template" value={templateId} />
      <input type="hidden" name="instanceType" value={instanceType} />
      <input type="hidden" name="bootScriptId" value={bootScriptId} />

      <PageSection title={t("accountTitle")} description={t("accountDescription")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("account")}>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger aria-label={t("account")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {t("accountOption", { name: a.name, provider: a.provider })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={providerId === "scaleway" ? t("zone") : t("region")}>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger aria-label={providerId === "scaleway" ? t("zone") : t("region")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </PageSection>

      <PageSection title={t("templateTitle")} description={t("templateDescription")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((tpl, i) => {
            const Icon = tpl.platform === "macos" ? Apple : tpl.platform === "windows" ? MonitorSmartphone : Server;
            const active = tpl.id === templateId;
            return (
              <m.button
                type="button"
                key={tpl.id}
                onClick={() => setTemplateId(tpl.id)}
                aria-pressed={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                whileTap={{ scale: 0.99 }}
                className={cn(
                  "surface card-hover relative flex min-h-[5.5rem] flex-col items-start gap-2 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  active && "border-[color-mix(in_oklch,var(--color-primary)_60%,var(--color-border))] shadow-[var(--shadow-glow)]",
                )}
              >
                <div className="flex w-full items-start justify-between">
                  <div className="grid size-9 place-items-center rounded-[var(--radius-md)] bg-bg-muted">
                    <Icon className="size-4" aria-hidden />
                  </div>
                  {active && <span className="text-xs font-medium text-primary">{t("selected")}</span>}
                </div>
                <div className="min-w-0">
                  <div className="font-semibold">{tpl.label}</div>
                  <div className="mt-1 text-xs text-muted">{tpl.description}</div>
                </div>
              </m.button>
            );
          })}
        </div>
      </PageSection>

      <PageSection title={t("sizeTitle")} description={t("sizeDescription")}>
        <div className="space-y-4">
          {sizes.length <= 6 ? (
            <ToggleGroup
              aria-label={t("sizeAria")}
              value={instanceType}
              onValueChange={setInstanceType}
              options={sizes.map((s) => ({ value: s, label: <span className="font-mono text-xs">{s}</span> }))}
              className="flex-wrap"
            />
          ) : (
            <div role="radiogroup" aria-label={t("sizeAria")} className="flex flex-wrap gap-2">
              {sizes.map((it) => (
                <button
                  type="button"
                  key={it}
                  role="radio"
                  aria-checked={it === instanceType}
                  onClick={() => setInstanceType(it)}
                  className={cn(
                    "min-h-10 rounded-full border px-3 py-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    it === instanceType
                      ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] text-primary"
                      : "border-border text-fg-muted hover:border-[color-mix(in_oklch,var(--color-primary)_50%,var(--color-border))] hover:text-fg",
                  )}
                >
                  {it}
                </button>
              ))}
            </div>
          )}
          {template?.notes && template.notes.length > 0 && (
            <Alert tone="warning" className="text-xs">
              <ul className="space-y-1">
                {template.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Alert>
          )}
          {accountId && instanceType && region && template && (
            <PriceEstimate
              accountId={accountId}
              provider={providerId}
              region={region}
              instanceType={instanceType}
              platform={template.platform}
            />
          )}
        </div>
      </PageSection>

      <PageSection title={t("detailsTitle")} description={t("detailsDescription")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")} hint={t.rich("nameHint", { code })}>
            <Input name="name" placeholder={t("namePlaceholder")} required />
          </Field>
          {providerId === "aws" && (
            <Field label={t("keyName")} hint={t("keyNameHint")}>
              <Input name="keyName" placeholder={t("keyNamePlaceholder")} />
            </Field>
          )}
          {(providerId === "azure" || providerId === "gcp") && template?.platform === "linux" && (
            <Field label={t("sshPublicKey")} hint={t.rich("sshPublicKeyHint", { code })} className="sm:col-span-2">
              <Textarea
                name="sshPublicKey"
                rows={3}
                spellCheck={false}
                placeholder={t("sshPublicKeyPlaceholder")}
                className="font-mono text-xs"
                required={providerId === "azure"}
              />
            </Field>
          )}
          {(providerId === "azure" || providerId === "gcp") && template?.platform === "windows" && (
            <>
              <Field label={t("adminUsername")}>
                <Input name="username" placeholder={t("adminUsernamePlaceholder")} autoComplete="off" />
              </Field>
              <Field label={t("adminPassword")} hint={t("adminPasswordHint")}>
                <Input name="password" type="password" placeholder={t("adminPasswordPlaceholder")} autoComplete="new-password" />
              </Field>
            </>
          )}
        </div>
      </PageSection>

      {showBootScript && (
        <PageSection title={t("bootScriptTitle")} description={t("bootScriptDescription")}>
          <Field label={t("bootScript")} hint={t.rich("bootScriptHint", { code })}>
            <Select
              value={bootScriptId || NO_BOOT_SCRIPT}
              onValueChange={(v) => setBootScriptId(v === NO_BOOT_SCRIPT ? "" : v)}
            >
              <SelectTrigger aria-label={t("bootScript")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_BOOT_SCRIPT}>{t("bootScriptNone")}</SelectItem>
                {bootScripts.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {t("bootScriptOption", { name: s.name, kind: s.kind })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </PageSection>
      )}

      <Alert tone="info" title={t("whatNextTitle")} className="text-xs">
        {t.rich("whatNextBody", { code })}
      </Alert>

      <Button type="submit" size="lg" loading={pending} className="w-full">
        {t("launch")}
      </Button>
    </form>
  );
}
