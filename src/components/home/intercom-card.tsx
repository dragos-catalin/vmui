"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/settings-panel";
import { useInterval, useIntercomState, type IntercomState } from "@/hooks/use-poll";
import { armIntercomAction, ignoreIntercomAction, openIntercomAction } from "@/server/actions/intercom";
import { BellRing, DoorOpen, PackageCheck, ShieldOff } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useHomeAction } from "./use-home-action";

export type IntercomCardState = IntercomState;

const LOG_EVENTS = ["ring", "end", "opened", "armed", "disarmed"] as const;
type LogEvent = (typeof LOG_EVENTS)[number];
const isLogEvent = (e: string): e is LogEvent => (LOG_EVENTS as readonly string[]).includes(e);

/** Electra IA02 intercom on the office ESP32: live call state, one-tap open,
 *  and the courier/guest auto-open arm with an expiry. Polls the state every
 *  3 s while mounted so a ring shows up without a reload. */
export function IntercomCard({ initial, token, canOpen = true }: { initial: IntercomCardState; token: string; canOpen?: boolean }) {
  const t = useTranslations("devices.intercom");
  const fmt = useFormatter();
  const { data: s } = useIntercomState(initial, { url: token ? `/api/esp/intercom?k=${encodeURIComponent(token)}` : undefined });
  const [now, setNow] = React.useState(() => Date.now());
  const action = useHomeAction(async (fn: () => Promise<{ ok: boolean; error?: string }>) => fn(), { error: t("toast.failed") });
  const busy = action.pending;

  const ago = (ms: number | null): string => {
    if (!ms) return t("ago.never");
    const sec = Math.max(0, Math.round((now - ms) / 1000));
    if (sec < 60) return t("ago.seconds", { n: sec });
    if (sec < 3600) return t("ago.minutes", { n: Math.round(sec / 60) });
    if (sec < 86400) return t("ago.hours", { n: Math.round(sec / 3600) });
    return fmt.dateTime(new Date(ms), { dateStyle: "medium" });
  };
  const clock = (ms: number) => fmt.dateTime(new Date(ms), { hour: "2-digit", minute: "2-digit" });

  useInterval(() => setNow(Date.now()), 3000);

  const armed = (s.autoOpenUntil ?? 0) > now;
  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await action.run(fn);
    if (r.ok) toast.success(label);
  };

  return (
    <Panel
      id="intercom"
      className={s.ringing ? "ring-2 ring-[var(--color-warning)]" : undefined}
      title={
        <span className="flex items-center gap-2">
          <BellRing className={s.ringing ? "size-4 text-warning-text motion-safe:animate-pulse" : "size-4 text-muted"} aria-hidden />
          {t("title")}
        </span>
      }
      description={t("description")}
      action={s.ringing ? <Badge variant="warning">{t("badge.ringing")}</Badge> : armed ? <Badge variant="success">{t("badge.armed", { left: ago(s.autoOpenUntil) })}</Badge> : <Badge variant="muted">{t("badge.quiet")}</Badge>}
    >
      <div className="space-y-4">
        {canOpen && <div className="flex flex-wrap gap-2">
          <Button variant={s.ringing ? "primary" : "secondary"} disabled={!s.ringing || busy} onClick={() => run(t("toast.opening"), openIntercomAction)}>
            <DoorOpen className="size-4" aria-hidden /> {t("actions.answerOpen")}
          </Button>
          <Button variant="secondary" disabled={!s.ringing || busy} onClick={() => run(t("toast.ignored"), ignoreIntercomAction)}>
            {t("actions.ignore")}
          </Button>
          {armed ? (
            <Button variant="ghost" disabled={busy} onClick={() => run(t("toast.disarmed"), () => armIntercomAction(0))}>
              <ShieldOff className="size-4" aria-hidden /> {t("actions.disarm")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => run(t("toast.armedFor", { n: 30 }), () => armIntercomAction(30))}>
                <PackageCheck className="size-4" aria-hidden /> {t("actions.armCourier")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => run(t("toast.armedFor", { n: 60 }), () => armIntercomAction(60))}>
                {t("actions.arm60")}
              </Button>
            </>
          )}
        </div>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("stats.state")}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{s.ringing ? t("badge.ringing") : t("badge.quiet")}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("stats.lastRing")}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{ago(s.lastRingAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("stats.lastOpen")}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{ago(s.lastOpenAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("stats.autoOpen")}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{armed && s.autoOpenUntil ? t("stats.until", { time: clock(s.autoOpenUntil) }) : t("stats.off")}</dd>
          </div>
        </dl>
        {s.log.length > 0 && (
          <ul className="max-h-64 divide-y divide-[var(--color-border)] overflow-y-auto text-sm" aria-label={t("logAria")}>
            {s.log.map((e) => (
              <li key={`${e.at}-${e.event}`} className="flex items-baseline gap-2 py-1.5">
                <time className="shrink-0 tabular-nums text-xs text-muted" dateTime={new Date(e.at).toISOString()}>
                  {clock(e.at)}
                </time>
                <span className="min-w-0 truncate">
                  {isLogEvent(e.event) ? t(`event.${e.event}`) : e.event} <span className="text-muted">· {e.by}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t("footnote")}</p>
      </div>
    </Panel>
  );
}
