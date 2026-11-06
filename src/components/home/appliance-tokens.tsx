"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APPLIANCE_PROFILE_IDS, type ApplianceProfile } from "@/lib/devices/appliance-scopes";
import { mintApplianceAction } from "@/server/actions/appliances";
import { Check, Copy, Cpu } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

/** Owner mints a scoped token per appliance (replaces the shared display token). Shown once. */
export function ApplianceTokens() {
  const t = useTranslations("notify.devices.appliance");
  const reduce = useReducedMotion();
  const [profile, setProfile] = React.useState<ApplianceProfile>("esp32");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [minted, setMinted] = React.useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = React.useState(false);

  const mint = async () => {
    setBusy(true);
    const r = await mintApplianceAction({ profile, name: name || t(`profiles.${profile}`) });
    setBusy(false);
    if (!r.ok) return void toast.error(t("failed"));
    setMinted({ name: name || t(`profiles.${profile}`), token: r.data.token });
    setName("");
    setCopied(false);
  };
  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
        <label className="sr-only" htmlFor="appliance-profile">{t("profile")}</label>
        <select id="appliance-profile" value={profile} onChange={(e) => setProfile(e.target.value as ApplianceProfile)} className="h-9 rounded-md border border-border-strong bg-surface px-2 text-sm">
          {APPLIANCE_PROFILE_IDS.map((p) => <option key={p} value={p}>{t(`profiles.${p}`)}</option>)}
        </select>
        <Input aria-label={t("name")} placeholder={t(`profiles.${profile}`)} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <Button onClick={mint} loading={busy}>
          <Cpu className="size-4" aria-hidden /> {t("mint")}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {minted && (
          <m.div key={minted.token} initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={reduce ? undefined : { opacity: 0, height: 0 }} className="overflow-hidden">
            <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <p className="font-medium">{t("once", { name: minted.name })}</p>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-bg-muted px-2 py-1 font-mono text-xs" title={minted.token}>{minted.token}</code>
                <Button variant="outline" size="sm" onClick={copy} aria-label={t("copy")}>
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted">{t("usage")}</p>
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => setMinted(null)}>{t("done")}</Button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
