"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/settings-panel";
import { useAction } from "@/hooks/use-action";
import { useEventSource } from "@/hooks/use-poll";
import { err, ok, type ActionResult } from "@/lib/action-result";
import { AppWindow, BatteryWarning, BellOff, BellRing, Bot, Check, Cpu, DoorOpen, GlassWater, Info, Mail, Monitor, Radar, Smartphone, Trash2, X } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { EASE_OUT } from "./home-motion";

type Action = { id: string; label: string; style: "primary" | "danger" | "ghost"; url?: string };
export type NotifyCard = {
  id: string; kind: string; title: string; body: string; subtitle: string | null; color: string | null; image: string | null;
  priority: "low" | "default" | "high" | "urgent"; progress: number | null; actions: Action[]; url: string | null; sticky: boolean;
  readAt: string | null; dismissedAt: string | null; createdAt: string; updatedAt: string;
};

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  copilot: Bot, agents: Bot, intercom: BellRing, pairing: Smartphone, water: GlassWater, pc: Monitor, pi: Cpu, door: DoorOpen, window: AppWindow, presence: Radar, battery: BatteryWarning, contact: Mail, system: Info,
};

async function post(url: string, body: unknown): Promise<ActionResult<{ message?: string }>> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({ ok: r.ok }))) as { ok?: boolean; message?: string; error?: string };
    return r.ok && j.ok !== false ? ok({ message: j.message }) : err(j.error ?? String(r.status));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Live view of the notification centre (SSE /api/notify/stream). Every card
 *  has the same buttons the phone shows; a new high-priority card also pops a
 *  sonner toast so it is seen from any tab. */
export function NotifyCenterCard() {
  const t = useTranslations("notify.centre");
  const format = useFormatter();
  const reduced = useReducedMotion();
  const [cards, setCards] = React.useState<NotifyCard[]>([]);
  const seen = React.useRef(new Set<string>());
  useEventSource<{ cards: NotifyCard[] } | NotifyCard>("/api/notify/stream", {
    events: ["snapshot", "upsert", "dismiss"],
    onMessage: (data, event) => {
      if (event === "snapshot") {
        const list = (data as { cards: NotifyCard[] }).cards;
        setCards(list);
        for (const c of list) seen.current.add(c.id);
        return;
      }
      const c = data as NotifyCard;
      if (event === "dismiss") return setCards((l) => l.filter((x) => x.id !== c.id));
      setCards((l) => [c, ...l.filter((x) => x.id !== c.id)]);
      if (!seen.current.has(c.id) && (c.priority === "high" || c.priority === "urgent")) {
        seen.current.add(c.id);
        toast(c.title, { description: c.body || c.subtitle || undefined, duration: c.priority === "urgent" ? 30000 : 10000 });
      }
    },
  });

  const opts = { refresh: false, error: t("actionFailed") } as const;
  const actAction = useAction((id: string, action: string) => post("/api/notify/act", { id, action }), { ...opts, success: (d) => d.message ?? t("actionDone") });
  const dismissAction = useAction((id: string) => post("/api/notify", { op: "dismiss", id }), opts);
  const clearAction = useAction(() => post("/api/notify", { op: "dismissAll" }), opts);

  const act = (c: NotifyCard, a: Action) => {
    if (a.url) {
      void post("/api/notify", { op: "read", ids: [c.id] });
      window.location.href = a.url;
      return;
    }
    void actAction.run(c.id, a.id);
  };
  // Optimistic: the card slides out at once; it comes back if the server refuses.
  const dismiss = async (c: NotifyCard) => {
    setCards((l) => l.filter((x) => x.id !== c.id));
    const r = await dismissAction.run(c.id);
    if (!r.ok) setCards((l) => (l.some((x) => x.id === c.id) ? l : [c, ...l]));
  };

  return (
    <Panel
      id="notify-centre"
      title={t("title")}
      description={t("description")}
      action={
        cards.some((c) => !c.sticky) ? (
          <Button variant="ghost" size="sm" loading={clearAction.pending} onClick={() => void clearAction.run()}>
            <Trash2 className="size-3.5" aria-hidden /> {t("clear")}
          </Button>
        ) : undefined
      }
    >
      {cards.length === 0 ? (
        <EmptyState compact icon={<BellOff />} title={t("empty")} />
      ) : (
        <ul className="grid max-h-[32rem] gap-2 overflow-y-auto overflow-x-hidden pr-1">
          <AnimatePresence initial={false}>
            {cards.map((c, i) => {
              const color = c.color ?? "var(--color-fg-muted)";
              const I = ICON[c.kind] ?? Info;
              return (
                <m.li
                  key={c.id}
                  layout={!reduced}
                  initial={{ opacity: 0, y: reduced ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT, delay: Math.min(i, 8) * 0.035 } }}
                  exit={{ opacity: 0, x: reduced ? 0 : 48, transition: { duration: 0.18, ease: EASE_OUT } }}
                  className="relative overflow-clip rounded-xl border border-border bg-bg-muted"
                  style={{ borderLeft: `3px solid ${color}` }}
                >
                  {c.image && (
                    // eslint-disable-next-line @next/next/no-img-element -- notification payload image, arbitrary origin
                    <img src={c.image} alt="" width={640} height={80} decoding="async" className="aspect-[8/1] h-20 w-full object-cover opacity-80" />
                  )}
                  <div className="flex gap-3 p-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 14%, transparent)`, color }}>
                      <I className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <div className="min-w-0 truncate text-sm font-medium" title={c.title}>{c.title}</div>
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{format.dateTime(new Date(c.updatedAt), { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      {c.subtitle && <div className="truncate text-xs text-fg-muted" title={c.subtitle}>{c.subtitle}</div>}
                      {c.body && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-sm text-muted">{c.body}</p>}
                      {c.progress != null && (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={100} aria-label={c.title}>
                          <m.div className="h-full" initial={false} animate={{ width: `${c.progress}%` }} style={{ background: color }} />
                        </div>
                      )}
                      {(c.actions.length > 0 || !c.sticky) && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {c.actions.map((a) => (
                            <Button key={a.id} size="sm" variant={a.style} disabled={actAction.pending} onClick={() => act(c, a)}>
                              {a.id === "approve" && <Check className="size-3.5" aria-hidden />}
                              {a.id === "reject" && <X className="size-3.5" aria-hidden />}
                              {a.label}
                            </Button>
                          ))}
                          {!c.sticky && (
                            <Button size="icon" variant="ghost" className="ml-auto" aria-label={t("closeAria", { title: c.title })} title={t("close")} onClick={() => void dismiss(c)}>
                              <X className="size-3.5" aria-hidden />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}
