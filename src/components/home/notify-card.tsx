"use client";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/settings-panel";
import { AppWindow, BatteryWarning, BellOff, BellRing, Bot, Check, Cpu, DoorOpen, GlassWater, Info, Mail, Monitor, Radar, Smartphone, Trash2, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

type Action = { id: string; label: string; style: "primary" | "danger" | "ghost"; url?: string };
export type NotifyCard = {
  id: string; kind: string; title: string; body: string; subtitle: string | null; color: string | null; image: string | null;
  priority: "low" | "default" | "high" | "urgent"; progress: number | null; actions: Action[]; url: string | null; sticky: boolean;
  readAt: string | null; dismissedAt: string | null; createdAt: string; updatedAt: string;
};

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  copilot: Bot, agents: Bot, intercom: BellRing, pairing: Smartphone, water: GlassWater, pc: Monitor, pi: Cpu, door: DoorOpen, window: AppWindow, presence: Radar, battery: BatteryWarning, contact: Mail, system: Info,
};

/** Live view of the notification centre (SSE /api/notify/stream). Every card
 *  has the same buttons the phone shows; a new high-priority card also pops a
 *  sonner toast so it is seen from any tab. */
export function NotifyCenterCard() {
  const t = useTranslations("notify.centre");
  const format = useFormatter();
  const [cards, setCards] = React.useState<NotifyCard[]>([]);
  const seen = React.useRef(new Set<string>());
  React.useEffect(() => {
    const es = new EventSource("/api/notify/stream");
    es.addEventListener("snapshot", (e) => {
      const j = JSON.parse((e as MessageEvent).data) as { cards: NotifyCard[] };
      setCards(j.cards);
      for (const c of j.cards) seen.current.add(c.id);
    });
    es.addEventListener("upsert", (e) => {
      const c = JSON.parse((e as MessageEvent).data) as NotifyCard;
      setCards((l) => [c, ...l.filter((x) => x.id !== c.id)]);
      if (!seen.current.has(c.id) && (c.priority === "high" || c.priority === "urgent")) {
        seen.current.add(c.id);
        toast(c.title, { description: c.body || c.subtitle || undefined, duration: c.priority === "urgent" ? 30000 : 10000 });
      }
    });
    es.addEventListener("dismiss", (e) => {
      const c = JSON.parse((e as MessageEvent).data) as NotifyCard;
      setCards((l) => l.filter((x) => x.id !== c.id));
    });
    return () => es.close();
  }, []);

  const act = async (c: NotifyCard, a: Action) => {
    if (a.url) {
      void fetch("/api/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read", ids: [c.id] }) });
      window.location.href = a.url;
      return;
    }
    const r = await fetch("/api/notify/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: c.id, action: a.id }) });
    const j = (await r.json()) as { ok: boolean; message?: string; error?: string };
    if (j.ok) toast.success(j.message ?? t("actionDone")); else toast.error(j.error ?? t("actionFailed"));
  };
  const dismiss = (id: string) => fetch("/api/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "dismiss", id }) });

  return (
    <Panel
      id="notify-centre"
      title={t("title")}
      description={t("description")}
      action={cards.some((c) => !c.sticky) ? (
        <Button variant="ghost" size="sm" onClick={() => fetch("/api/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "dismissAll" }) })}>
          <Trash2 className="size-3.5" /> {t("clear")}
        </Button>
      ) : undefined}
    >
      {cards.length === 0 ? (
        <div className="grid place-items-center gap-1.5 py-8 text-muted">
          <BellOff className="size-6 opacity-50" />
          <div className="text-xs">{t("empty")}</div>
        </div>
      ) : (
        <ul className="grid max-h-[32rem] gap-2 overflow-y-auto pr-1">
          {cards.map((c) => {
            const color = c.color ?? "var(--color-fg-muted)";
            const I = ICON[c.kind] ?? Info;
            return (
              <li key={c.id} className="relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]" style={{ borderLeft: `3px solid ${color}` }}>
                {c.image && <img src={c.image} alt="" className="h-20 w-full object-cover opacity-80" />}
                <div className="flex gap-3 p-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 14%, transparent)`, color }}><I className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <div className="min-w-0 truncate text-sm font-medium">{c.title}</div>
                      <span className="ml-auto shrink-0 text-xs text-muted tabular-nums">{format.dateTime(new Date(c.updatedAt), { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    {c.subtitle && <div className="truncate text-xs" style={{ color }}>{c.subtitle}</div>}
                    {c.body && <p className="mt-0.5 whitespace-pre-line text-sm text-muted line-clamp-2">{c.body}</p>}
                    {c.progress != null && <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-border)]"><div className="h-full" style={{ width: `${c.progress}%`, background: color }} /></div>}
                    {(c.actions.length > 0 || !c.sticky) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {c.actions.map((a) => (
                          <Button key={a.id} size="sm" variant={a.style} onClick={() => act(c, a)}>
                            {a.id === "approve" && <Check className="size-3.5" />}
                            {a.id === "reject" && <X className="size-3.5" />}
                            {a.label}
                          </Button>
                        ))}
                        {!c.sticky && <Button size="sm" variant="ghost" className="ml-auto" aria-label={t("close")} onClick={() => dismiss(c.id)}><X className="size-3.5" /></Button>}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
