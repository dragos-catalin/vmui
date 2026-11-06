"use client";

import { Button } from "@/components/ui/button";
import { QrCode, RefreshCw } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

type Invite = { link: string; hub: string; expiresAt: number };

/** "Add a device": one-time QR the Vatra app scans; the device is approved as the signed-in member. */
export function PairQr() {
  const t = useTranslations("notify.devices.qr");
  const reduce = useReducedMotion();
  const [inv, setInv] = React.useState<Invite | null>(null);
  const [svg, setSvg] = React.useState<string>("");
  const [left, setLeft] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  const make = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/devices/pair/invite", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as Invite;
      const QR = await import("qrcode");
      setSvg(await QR.toString(j.link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }));
      setInv(j);
    } catch {
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => {
    if (!inv) return;
    const tick = () => {
      const s = Math.max(0, Math.round((inv.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setInv(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [inv]);

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait" initial={false}>
        {inv ? (
          <m.figure
            key="qr"
            initial={reduce ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.22 }}
            className="flex flex-col items-center gap-2"
          >
            {/* white plate: scanners need contrast in dark mode too */}
            <div role="img" aria-label={t("alt")} className="size-52 rounded-xl bg-white p-2 shadow-sm [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
            <figcaption className="text-center text-xs text-muted">
              {t("hint")}
              <span className="mt-1 block font-mono tabular-nums" aria-live="polite">{t("expires", { seconds: left })}</span>
              <span className="mt-1 block truncate font-mono" title={inv.hub}>{inv.hub}</span>
            </figcaption>
          </m.figure>
        ) : null}
      </AnimatePresence>
      <Button variant={inv ? "ghost" : "outline"} onClick={make} loading={busy} className="w-full sm:w-auto">
        {inv ? <RefreshCw className="size-4" aria-hidden /> : <QrCode className="size-4" aria-hidden />}
        {inv ? t("renew") : t("show")}
      </Button>
    </div>
  );
}
