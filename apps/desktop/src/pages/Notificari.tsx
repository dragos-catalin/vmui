import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppWindow, BatteryWarning, Bell, BellOff, BellRing, Bot, Check, Cpu, DoorOpen, GlassWater, Info, Mail, Monitor, Radar, Settings2, Smartphone, Trash2, X } from "lucide-react";
import * as React from "react";
import { api, cn, toast, useEvent } from "../lib";
import { usePlatform } from "../platform";
import { Card, Row, Seg, Switch } from "../ui";

export type NotifyAction = { id: string; label: string; style: "primary" | "danger" | "ghost"; url?: string };
export type NotifyCard = {
  id: string; kind: string; tag: string | null; title: string; body: string; subtitle: string | null; color: string | null; icon: string | null; image: string | null;
  priority: "low" | "default" | "high" | "urgent"; progress: number | null; actions: NotifyAction[]; url: string | null; data: Record<string, unknown>; sticky: boolean;
  readAt: string | null; dismissedAt: string | null; actedWith: string | null; actedBy: string | null; deliveredTo: string | null; fallbackAt: string | null; createdAt: string; updatedAt: string;
};
type Settings = {
  kinds: Record<string, { enabled: boolean; breakQuiet: boolean; color?: string; icon?: string }>;
  quiet: { enabled: boolean; from: string; to: string };
  fcm: { enabled: boolean };
  haFallback: boolean;
  waterNudgeMl: number;
  batteryBelow: number;
};
type Meta = Record<string, { label: string; color: string; icon: string }>;

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  copilot: Bot, agents: Bot, intercom: BellRing, pairing: Smartphone, water: GlassWater, pc: Monitor, pi: Cpu, door: DoorOpen, window: AppWindow, presence: Radar, battery: BatteryWarning, contact: Mail, system: Info,
};

function useNotifyApi() {
  const { mobile } = usePlatform();
  return React.useMemo(
    () => ({
      list: (all: boolean) => (mobile ? api.vmuiGet<{ cards: NotifyCard[] }>(`/api/notify${all ? "?all=1" : ""}`) : invoke<{ cards: NotifyCard[] }>("notify_list", { all })),
      act: (id: string, action: string) => (mobile ? api.vmuiSend<{ ok: boolean; message?: string; error?: string }>("POST", "/api/notify/act", { id, action }) : invoke<{ ok: boolean; message?: string; error?: string }>("notify_act", { id, action })),
      op: (body: { op: string; id?: string; ids?: string[] }) => (mobile ? api.vmuiSend("POST", "/api/notify", body) : invoke("notify_op", body)),
      settings: (save?: Settings): Promise<{ settings: Settings; meta?: Meta; fcm?: boolean }> =>
        mobile
          ? save ? api.vmuiSend<{ settings: Settings }>("PUT", "/api/notify/settings", save) : api.vmuiGet<{ settings: Settings; meta: Meta; fcm: boolean }>("/api/notify/settings")
          : invoke<{ settings: Settings; meta?: Meta; fcm?: boolean }>("notify_settings", { save }),
    }),
    [mobile],
  );
}

/** Open cards with live updates: desktop gets `notify` events from Rust; mobile polls while visible. */
export function useNotifications() {
  const { mobile } = usePlatform();
  const n = useNotifyApi();
  const [cards, setCards] = React.useState<NotifyCard[]>([]);
  const load = React.useCallback(() => n.list(false).then((r) => setCards(r.cards)).catch(() => undefined), [n]);
  React.useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), mobile ? 5000 : 30000);
    return () => clearInterval(id);
  }, [load, mobile]);
  useEvent<{ type: string; card?: NotifyCard; cards?: NotifyCard[] }>("notify", (ev) => {
    if (ev.type === "snapshot" && ev.cards) setCards(ev.cards);
    else if (ev.type === "upsert" && ev.card) setCards((l) => [ev.card!, ...l.filter((c) => c.id !== ev.card!.id)]);
    else if (ev.type === "dismiss" && ev.card) setCards((l) => l.filter((c) => c.id !== ev.card!.id));
  });
  return { cards, reload: load, api: n };
}

export function NotifBell({ onClick, count }: { onClick: () => void; count: number }) {
  return (
    <button type="button" className="btn ghost sm relative" onClick={onClick} aria-label={`Notificări${count ? `, ${count} necitite` : ""}`}>
      <Bell className="size-4" />
      {count > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-warn text-[10px] font-bold text-black grid place-items-center px-1">{count > 9 ? "9+" : count}</span>}
    </button>
  );
}

export function Notificari({ focusId }: { focusId?: string | null }) {
  const { cards, reload, api: n } = useNotifications();
  const [tab, setTab] = React.useState<"open" | "history" | "settings">("open");
  const [history, setHistory] = React.useState<NotifyCard[]>([]);
  const [filter, setFilter] = React.useState<string>("all");
  React.useEffect(() => {
    if (tab !== "history") return;
    n.list(true).then((r) => setHistory(r.cards.filter((c) => c.dismissedAt))).catch(() => undefined);
  }, [tab, n]);
  // opening the page marks what is visible as read
  React.useEffect(() => {
    const unread = cards.filter((c) => !c.readAt).map((c) => c.id);
    if (unread.length) void n.op({ op: "read", ids: unread }).then(reload).catch(() => undefined);
  }, [cards, n, reload]);
  React.useEffect(() => {
    if (!focusId) return;
    document.getElementById(`n-${focusId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, cards]);

  const kinds = Array.from(new Set(cards.map((c) => c.kind)));
  const shown = filter === "all" ? cards : cards.filter((c) => c.kind === filter);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-semibold tracking-tight mr-auto">Notificări</h1>
        <Seg value={tab} onChange={setTab} options={[{ id: "open", label: cards.length ? `Active · ${cards.length}` : "Active" }, { id: "history", label: "Istoric" }, { id: "settings", label: "", icon: <Settings2 className="size-4" /> }]} />
      </div>
      {tab === "open" && (
        <>
          {kinds.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              <Chip on={filter === "all"} onClick={() => setFilter("all")}>Toate</Chip>
              {kinds.map((k) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>{LABEL[k] ?? k}</Chip>)}
              {cards.some((c) => !c.sticky) && <button type="button" className="btn ghost sm ml-auto" onClick={() => n.op({ op: "dismissAll" }).then(reload)}><Trash2 className="size-3.5" />Curăță</button>}
            </div>
          )}
          {shown.length === 0 ? (
            <div className="glass grid place-items-center gap-2 py-14 text-muted">
              <BellOff className="size-8 opacity-50" />
              <div className="text-sm">Nimic nou. Totul e liniștit acasă.</div>
            </div>
          ) : (
            <div className="grid gap-2.5">{shown.map((c) => <NotifCardView key={c.id} card={c} focus={c.id === focusId} onAct={(a) => act(n, c, a, reload)} onDismiss={() => n.op({ op: "dismiss", id: c.id }).then(reload)} />)}</div>
          )}
        </>
      )}
      {tab === "history" && (
        <div className="grid gap-1.5">
          {history.length === 0 && <div className="text-sm text-muted py-8 text-center">Istoric gol.</div>}
          {history.map((c) => (
            <div key={c.id} className="glass flex items-center gap-3 px-3 py-2 opacity-80">
              <KindDot kind={c.kind} color={c.color} />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{c.title}</div>
                <div className="text-[11px] text-dim truncate">{fmtWhen(c.createdAt)} · {c.actedWith ? `${c.actedWith} · ${c.actedBy ?? ""}` : c.fallbackAt ? "prin HA Companion" : c.deliveredTo ? `livrat pe ${c.deliveredTo}` : "expirat"}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === "settings" && <NotifSettings />}
    </div>
  );
}

const LABEL: Record<string, string> = { copilot: "Copilot", agents: "Agenți", intercom: "Interfon", pairing: "Dispozitive", water: "Apă", pc: "PC", pi: "Pi", door: "Ușă", window: "Geam", presence: "Prezență", battery: "Baterii", contact: "Contact", system: "Sistem" };

async function act(n: ReturnType<typeof useNotifyApi>, c: NotifyCard, a: NotifyAction, reload: () => void) {
  if (a.url) {
    void n.op({ op: "read", ids: [c.id] });
    try { await openUrl(a.url); } catch (e) { toast("error", `nu pot deschide ${a.url}: ${String(e)}`); }
    return;
  }
  try {
    const r = await n.act(c.id, a.id);
    if (r.ok) toast("ok", r.message ?? "gata"); else toast("error", r.error ?? "nu a mers");
  } catch (e) {
    toast("error", String(e));
  }
  reload();
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={cn("btn ghost sm rounded-full", on && "on")} onClick={onClick}>{children}</button>;
}

function KindDot({ kind, color }: { kind: string; color: string | null }) {
  const I = ICON[kind] ?? Info;
  return (
    <span className="size-9 shrink-0 rounded-full grid place-items-center" style={{ background: `${color ?? "#94a3b8"}22`, color: color ?? "#94a3b8" }}>
      <I className="size-4.5" />
    </span>
  );
}

export function NotifCardView({ card: c, focus, onAct, onDismiss, compact }: { card: NotifyCard; focus?: boolean; onAct: (a: NotifyAction) => void; onDismiss: () => void; compact?: boolean }) {
  const color = c.color ?? "#94a3b8";
  return (
    <article
      id={`n-${c.id}`}
      className={cn("glass relative overflow-hidden transition-shadow", focus && "ring-2 ring-white/40", c.priority === "urgent" && "border-down/60", !c.readAt && "border-l-2")}
      style={{ borderLeftColor: !c.readAt ? color : undefined, boxShadow: c.priority === "urgent" ? `0 0 0 1px ${color}66, 0 12px 40px -18px ${color}` : undefined }}
    >
      {c.image && !compact && (
        <div className="relative h-36 -mb-6">
          <img src={c.image} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-[var(--bg-1,#0b0f1a)]" />
        </div>
      )}
      <div className="relative flex gap-3 px-3.5 py-3">
        <KindDot kind={c.kind} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[15px] font-semibold leading-tight truncate">{c.title}</h3>
            <span className="ml-auto shrink-0 text-[11px] text-dim tabular-nums">{fmtWhen(c.updatedAt)}</span>
          </div>
          {c.subtitle && <div className="text-xs mt-0.5" style={{ color }}>{c.subtitle}</div>}
          {c.body && <p className="text-sm text-muted mt-1 whitespace-pre-line leading-snug line-clamp-4">{c.body}</p>}
          {c.progress != null && (
            <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${c.progress}%`, background: color }} />
            </div>
          )}
          {(c.actions.length > 0 || !c.sticky) && (
            <div className="mt-2.5 flex gap-1.5 flex-wrap">
              {c.actions.map((a) => (
                <button key={a.id} type="button" className={cn("btn sm", a.style === "primary" && "primary", a.style === "danger" && "danger", a.style === "ghost" && "ghost")} style={a.style === "primary" ? { background: color, borderColor: color, color: "#0b0f1a" } : undefined} onClick={() => onAct(a)}>
                  {a.id === "approve" && <Check className="size-3.5" />}
                  {a.id === "reject" && <X className="size-3.5" />}
                  {a.label}
                </button>
              ))}
              {!c.sticky && <button type="button" className="btn ghost sm ml-auto" onClick={onDismiss} aria-label="Închide"><X className="size-3.5" /></button>}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "acum";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("ro-RO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function NotifSettings() {
  const n = useNotifyApi();
  const [s, setS] = React.useState<Settings | null>(null);
  const [meta, setMeta] = React.useState<Meta>({});
  const [fcm, setFcm] = React.useState<boolean | null>(null);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    n.settings().then((r) => { setS(r.settings); if (r.meta) setMeta(r.meta); if (typeof r.fcm === "boolean") setFcm(r.fcm); }).catch((e) => toast("error", String(e)));
  }, [n]);
  if (!s) return <div className="text-sm text-muted">se încarcă…</div>;
  const patch = (f: (x: Settings) => Settings) => { setS((x) => (x ? f(x) : x)); setDirty(true); };
  const save = () => n.settings(s).then(() => { toast("ok", "salvat"); setDirty(false); }).catch((e) => toast("error", String(e)));
  return (
    <div className="grid gap-4">
      <Card title="Ore de liniște" sub="Cardurile discrete așteaptă; interfonul și ușa trec oricum (bifă „și noaptea”).">
        <Row label="Activ"><Switch checked={s.quiet.enabled} onChange={(v) => patch((x) => ({ ...x, quiet: { ...x.quiet, enabled: v } }))} /></Row>
        <Row label="De la"><input className="field w-28" type="time" value={s.quiet.from} onChange={(e) => patch((x) => ({ ...x, quiet: { ...x.quiet, from: e.target.value } }))} /></Row>
        <Row label="Până la"><input className="field w-28" type="time" value={s.quiet.to} onChange={(e) => patch((x) => ({ ...x, quiet: { ...x.quiet, to: e.target.value } }))} /></Row>
      </Card>
      <Card title="Tipuri" sub="Ce ajunge pe telefon și pe PC.">
        <div className="grid gap-1">
          {Object.entries(s.kinds).map(([k, v]) => {
            const I = ICON[k] ?? Info;
            return (
              <div key={k} className="flex items-center gap-3 py-1.5">
                <span className="size-8 rounded-full grid place-items-center" style={{ background: `${v.color ?? meta[k]?.color ?? "#94a3b8"}22`, color: v.color ?? meta[k]?.color ?? "#94a3b8" }}><I className="size-4" /></span>
                <div className="flex-1 text-sm">{meta[k]?.label ?? LABEL[k] ?? k}</div>
                <label className="flex items-center gap-1.5 text-[11px] text-dim"><input type="checkbox" checked={v.breakQuiet} onChange={(e) => patch((x) => ({ ...x, kinds: { ...x.kinds, [k]: { ...v, breakQuiet: e.target.checked } } }))} />și noaptea</label>
                <Switch checked={v.enabled} onChange={(on) => patch((x) => ({ ...x, kinds: { ...x.kinds, [k]: { ...v, enabled: on } } }))} />
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Livrare">
        <Row label="Trezire prin FCM" hint={fcm === false ? "cheia de serviciu lipsește pe Pi (.private/fcm-service-account.json)" : "telefonul primește cardul și când aplicația e închisă"}><Switch checked={s.fcm.enabled} onChange={(v) => patch((x) => ({ ...x, fcm: { enabled: v } }))} /></Row>
        <Row label="Rezervă HA Companion" hint="dacă niciun dispozitiv nu confirmă în 20 s, trimite prin aplicația Home Assistant"><Switch checked={s.haFallback} onChange={(v) => patch((x) => ({ ...x, haFallback: v }))} /></Row>
        <Row label="Apă: sub ritm cu" hint="0 = fără"><input className="field w-24" type="number" min={0} max={1000} step={50} value={s.waterNudgeMl} onChange={(e) => patch((x) => ({ ...x, waterNudgeMl: Number(e.target.value) }))} /> <span className="text-xs text-muted">ml</span></Row>
        <Row label="Baterie sub"><input className="field w-20" type="number" min={5} max={50} value={s.batteryBelow} onChange={(e) => patch((x) => ({ ...x, batteryBelow: Number(e.target.value) }))} /> <span className="text-xs text-muted">%</span></Row>
      </Card>
      {dirty && (
        <div className="sticky bottom-2 flex justify-end">
          <button type="button" className="btn primary" onClick={save}>Salvează</button>
        </div>
      )}
    </div>
  );
}
