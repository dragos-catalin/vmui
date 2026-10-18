"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Panel, Subsection } from "@/components/ui/settings-panel";
import { SkeletonList } from "@/components/ui/skeleton";
import { useAction } from "@/hooks/use-action";
import { usePairedDevices } from "@/hooks/use-poll";
import { err, ok, type ActionResult } from "@/lib/action-result";
import { Check, Laptop, Smartphone, Trash2, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { EASE_OUT } from "./home-motion";

type T = ReturnType<typeof useTranslations<"notify.devices">>;

const PLATFORM_KEYS = ["android", "ios", "windows", "macos", "linux", "web"] as const;

/** Phones and desktops paired with vmui. Long-polls /api/devices so a new
 *  pairing request pops up here (and as a toast) within a second. */
export function PairedDevicesCard() {
  const t = useTranslations("notify.devices");
  const common = useTranslations("common");
  const confirm = useConfirm();
  const { data, pending } = usePairedDevices();
  const [busy, setBusy] = React.useState<string | null>(null);
  const announced = React.useRef(new Set<string>());
  const action = useAction(
    async (body: Record<string, unknown>): Promise<ActionResult> => {
      try {
        const r = await fetch("/api/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = (await r.json()) as { ok: boolean; error?: string };
        return j.ok ? ok() : err(j.error ?? t("opError"));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    { refresh: false, error: t("opError") },
  );

  React.useEffect(() => {
    for (const p of pending) {
      if (!announced.current.has(p.id)) {
        announced.current.add(p.id);
        toast(t("newDeviceTitle", { name: p.name }), { description: t("newDeviceBody", { code: p.code }), duration: 15000 });
      }
    }
  }, [pending, t]);

  const op = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(String(body.id));
    const r = await action.run(body);
    setBusy(null);
    if (r.ok) toast.success(okMsg);
  };
  const revoke = async (id: string, name: string) => {
    const yes = await confirm({ title: t("revokeConfirm", { name }), tone: "danger", confirmText: t("revoke"), cancelText: common("cancel") });
    if (yes) await op({ op: "revoke", id }, t("revoked", { name }));
  };

  const approved = data?.devices.filter((d) => d.status === "approved") ?? [];
  const revoked = data?.devices.filter((d) => d.status === "revoked") ?? [];
  return (
    <Panel
      id="paired-devices"
      title={t("title")}
      description={t("description")}
      action={data && data.pending.length > 0 ? <Badge variant="warning">{t("pendingBadge", { count: data.pending.length })}</Badge> : undefined}
    >
      {data && data.pending.length > 0 && (
        <Subsection
          title={t("pendingTitle")}
          hint={t("pendingHint")}
          className="mb-4 space-y-3 border-[color-mix(in_oklch,var(--color-warning)_50%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]"
        >
          <ul className="grid gap-2" role="status">
            {data.pending.map((p) => (
              <li key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                <Icon platform={p.platform} />
                <div className="min-w-0">
                  <div className="min-w-0 truncate text-sm font-medium" title={p.name}>{p.name}</div>
                  <div className="truncate text-xs text-muted">{platformLabel(t, p.platform)} · {t("requestFrom", { ip: p.lastIp ?? t("unknownIp") })}</div>
                </div>
                <div className="font-mono text-lg tabular-nums tracking-widest">{p.code}</div>
                <div className="col-span-3 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" className="shrink-0" disabled={busy === p.id} onClick={() => void op({ op: "reject", id: p.id }, t("rejected"))}>
                    <X className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{t("reject")}</span>
                  </Button>
                  <Button size="sm" className="shrink-0" disabled={busy === p.id} onClick={() => void op({ op: "approve", id: p.id, code: p.code }, t("approved", { name: p.name }))}>
                    <Check className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{t("approve")}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Subsection>
      )}

      {!data ? (
        <div role="status" aria-label={t("loading")}>
          <SkeletonList rows={2} />
        </div>
      ) : approved.length === 0 && data.pending.length === 0 ? (
        <p className="text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          <AnimatePresence initial={false}>
          {approved.map((d, i) => (
            <m.li
              key={d.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT, delay: Math.min(i, 8) * 0.035 } }}
              exit={{ opacity: 0, x: 32, transition: { duration: 0.18 } }}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5"
            >
              <Icon platform={d.platform} />
              <div className="min-w-0">
                <div className="min-w-0 truncate text-sm font-medium" title={d.name}>{d.name}</div>
                <div className="truncate text-xs text-muted" title={d.approvedBy ? t("approvedBy", { name: d.approvedBy }) : undefined}>
                  {[
                    platformLabel(t, d.platform),
                    d.lastSeenAt ? t("seen", { ago: ago(t, d.lastSeenAt) }) : t("unused"),
                    d.lastIp,
                    d.approvedBy ? t("approvedBy", { name: d.approvedBy }) : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0" aria-label={t("revokeAria", { name: d.name })} disabled={busy === d.id} onClick={() => void revoke(d.id, d.name)}>
                <Trash2 className="size-4" aria-hidden /><span className="hidden sm:inline">{t("revoke")}</span>
              </Button>
            </m.li>
          ))}
          </AnimatePresence>
        </ul>
      )}
      {revoked.length > 0 && <p className="mt-3 text-xs text-muted">{t("revokedCount", { count: revoked.length })}</p>}
    </Panel>
  );
}

function Icon({ platform }: { platform: string }) {
  return /android|ios|iphone/i.test(platform) ? <Smartphone className="size-5 text-fg-muted" aria-hidden /> : <Laptop className="size-5 text-fg-muted" aria-hidden />;
}

function platformLabel(t: T, platform: string): string {
  const p = platform.toLowerCase();
  const key = PLATFORM_KEYS.find((k) => p === k || (k === "ios" && /iphone|ipad/.test(p)) || (k === "macos" && /darwin|mac/.test(p)) || (k === "windows" && /win/.test(p)));
  return key ? t(`platform.${key}`) : platform;
}

function ago(t: T, d: string | Date): string {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return t("ago.now");
  if (s < 3600) return t("ago.minutes", { n: Math.round(s / 60) });
  if (s < 86400) return t("ago.hours", { n: Math.round(s / 3600) });
  return t("ago.days", { n: Math.round(s / 86400) });
}
