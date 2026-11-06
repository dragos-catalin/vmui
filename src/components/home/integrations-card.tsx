"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SettingsPanel, Subsection } from "@/components/ui/settings-panel";
import type { Household } from "@/lib/household-model";
import type { IntegrationsView } from "@/server/actions/integrations";
import { saveHouseholdAction, saveIntegrationsAction, testHomeAssistantAction } from "@/server/actions/integrations";
import { CheckCircle2, Home, PlugZap, Power } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useHomeAction } from "./use-home-action";

type Props = { integrations: IntegrationsView; household: Household; defaultOpen?: boolean };

const ZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC", "Europe/Bucharest", "Europe/London", "Europe/Berlin", "America/New_York"];

/** Owner-only: Home Assistant connection, household facts, Wake-on-LAN. Secrets are never echoed back. */
export function IntegrationsCard({ integrations, household, defaultOpen = false }: Props) {
  const t = useTranslations("setup.integrations");
  const errorText = (e: string) => (t.has(`errors.${e}` as never) ? t(`errors.${e}` as never) : t("failed"));
  const [ha, setHa] = React.useState({ url: integrations.HA_URL.value ?? "", token: "" });
  const [hh, setHh] = React.useState<Household>(household);
  const [wol, setWol] = React.useState({ mac: integrations.PC_WOL_MAC.value ?? "", ip: integrations.PC_WOL_IP.value ?? "" });
  const [probe, setProbe] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const saveInt = useHomeAction(saveIntegrationsAction, { success: t("saved"), error: t("failed"), refresh: true });
  const saveHh = useHomeAction(saveHouseholdAction, { success: t("saved"), error: t("failed"), refresh: true });

  const test = async () => {
    setBusy("test");
    const r = await testHomeAssistantAction({ url: ha.url, token: ha.token });
    setBusy(null);
    setProbe(r.ok ? { ok: true, text: t("connected", { name: r.data.locationName || "Home Assistant", version: r.data.version }) } : { ok: false, text: errorText(r.error) });
  };
  const saveHa = async () => {
    setBusy("ha");
    const r = await saveInt.run({ HA_URL: ha.url, HA_TOKEN: ha.token });
    setBusy(null);
    if (!r.ok) toast.error(errorText(r.error));
    else setHa((p) => ({ ...p, token: "" }));
  };
  const saveHousehold = async () => {
    setBusy("hh");
    const r = await saveHh.run({ timeZone: hh.timeZone, locale: hh.locale, ownerPerson: hh.ownerPerson, ownerPhone: hh.ownerPhone, publicUrl: hh.publicUrl });
    setBusy(null);
    if (!r.ok) toast.error(errorText(r.error));
  };
  const saveWol = async () => {
    setBusy("wol");
    const r = await saveInt.run({ PC_WOL_MAC: wol.mac || "-", PC_WOL_IP: wol.ip || "-" });
    setBusy(null);
    if (!r.ok) toast.error(errorText(r.error));
  };

  return (
    <SettingsPanel
      id="integrations"
      icon={<PlugZap className="size-4" aria-hidden />}
      title={t("title")}
      summary={integrations.HA_TOKEN.set ? <Badge variant="success">Home Assistant</Badge> : t("summary")}
      defaultOpen={defaultOpen}
    >
      <div className="space-y-4">
        <Subsection title={t("ha")} hint={t("haHint")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("haUrl")}>
              <Input value={ha.url} onChange={(e) => setHa((p) => ({ ...p, url: e.target.value }))} placeholder="http://homeassistant.local:8123" inputMode="url" autoComplete="off" spellCheck={false} className="font-mono text-xs" />
            </Field>
            <Field label={t("haToken")} hint={integrations.HA_TOKEN.set ? t("haTokenSet") : undefined}>
              <Input value={ha.token} onChange={(e) => setHa((p) => ({ ...p, token: e.target.value }))} placeholder={t("haTokenPlaceholder")} type="password" autoComplete="off" spellCheck={false} className="font-mono text-xs" />
            </Field>
          </div>
          {probe && (
            <p role="status" className={probe.ok ? "mt-3 flex items-center gap-1.5 text-sm text-success" : "mt-3 text-sm text-danger"}>
              {probe.ok && <CheckCircle2 className="size-4" aria-hidden />}
              {probe.text}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={test} loading={busy === "test"}>{busy === "test" ? t("testing") : t("test")}</Button>
            <Button onClick={saveHa} loading={busy === "ha"} disabled={!ha.url}>{t("save")}</Button>
          </div>
        </Subsection>

        <Subsection title={<span className="inline-flex items-center gap-1.5"><Home className="size-3.5" aria-hidden />{t("household")}</span>} hint={t("householdHint")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("timeZone")}>
              <select value={hh.timeZone} onChange={(e) => setHh((p) => ({ ...p, timeZone: e.target.value }))} className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-sm">
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
            <Field label={t("locale")}>
              <select value={hh.locale} onChange={(e) => setHh((p) => ({ ...p, locale: e.target.value as Household["locale"] }))} className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-sm">
                <option value="en">English</option>
                <option value="ro">Română</option>
              </select>
            </Field>
            <Field label={t("ownerPerson")} hint={t("ownerPersonHint")}>
              <Input value={hh.ownerPerson} onChange={(e) => setHh((p) => ({ ...p, ownerPerson: e.target.value }))} placeholder="person.ana" className="font-mono text-xs" spellCheck={false} />
            </Field>
            <Field label={t("ownerPhone")} hint={t("ownerPhoneHint")}>
              <Input value={hh.ownerPhone} onChange={(e) => setHh((p) => ({ ...p, ownerPhone: e.target.value }))} placeholder="pixel_9" className="font-mono text-xs" spellCheck={false} />
            </Field>
            <Field label={t("publicUrl")} hint={t("publicUrlHint")} className="sm:col-span-2">
              <Input value={hh.publicUrl} onChange={(e) => setHh((p) => ({ ...p, publicUrl: e.target.value }))} placeholder="https://vatra.example.com" inputMode="url" className="font-mono text-xs" spellCheck={false} />
            </Field>
          </div>
          <div className="mt-3"><Button onClick={saveHousehold} loading={busy === "hh"}>{t("save")}</Button></div>
        </Subsection>

        <Subsection title={<span className="inline-flex items-center gap-1.5"><Power className="size-3.5" aria-hidden />{t("wol")}</span>} collapsible defaultOpen={false}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("wolMac")}>
              <Input value={wol.mac} onChange={(e) => setWol((p) => ({ ...p, mac: e.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" className="font-mono text-xs" spellCheck={false} />
            </Field>
            <Field label={t("wolIp")}>
              <Input value={wol.ip} onChange={(e) => setWol((p) => ({ ...p, ip: e.target.value }))} placeholder="192.168.1.255" className="font-mono text-xs" spellCheck={false} />
            </Field>
          </div>
          <div className="mt-3"><Button variant="outline" onClick={saveWol} loading={busy === "wol"}>{t("save")}</Button></div>
        </Subsection>
      </div>
    </SettingsPanel>
  );
}
