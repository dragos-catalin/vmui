import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppWindow, BatteryWarning, Bell, BellRing, Bot, Check, Cpu, DoorOpen, GlassWater, Info, Mail, Monitor, Radar, Settings2, Smartphone, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n, { currentLocale, tx } from "../i18n";
import { api, cn, reducedMotion, toast, useEvent, useInterval } from "../lib";
import { usePlatform } from "../platform";
import { Card, EmptyState, ErrorState, Loading, PageHeader, Row, Seg, Switch } from "../ui";

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
const FALLBACK = "var(--color-muted)";
const tint = (c: string, pct = 13) => `color-mix(in oklch, ${c} ${pct}%, transparent)`;

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

type NotifState = { cards: NotifyCard[]; loaded: boolean; error: string | null; reload: () => Promise<void>; api: ReturnType<typeof useNotifyApi> };
const NotifCtx = React.createContext<NotifState | null>(null);

/** Open cards with live updates, mounted ONCE for the shell (DK-12): desktop gets `notify` events
 *  from Rust (+ a 30 s resync); mobile polls every 5 s. Both only while the window is visible. */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { mobile } = usePlatform();
  const n = useNotifyApi();
  const [cards, setCards] = React.useState<NotifyCard[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => n.list(false).then((r) => { setCards(r.cards); setLoaded(true); setError(null); }).catch((e) => setError(String(e).replace(/^Error:\s*/, ""))), [n]);
  useInterval(() => void load(), mobile ? 5000 : 30000);
  useEvent<{ type: string; card?: NotifyCard; cards?: NotifyCard[] }>("notify", (ev) => {
    if (ev.type === "snapshot" && ev.cards) { setCards(ev.cards); setLoaded(true); }
    else if (ev.type === "upsert" && ev.card) setCards((l) => [ev.card!, ...l.filter((c) => c.id !== ev.card!.id)]);
    else if (ev.type === "dismiss" && ev.card) setCards((l) => l.filter((c) => c.id !== ev.card!.id));
  });
  const value = React.useMemo(() => ({ cards, loaded, error, reload: load, api: n }), [cards, loaded, error, load, n]);
  return <NotifCtx.Provider value={value}>{children}</NotifCtx.Provider>;
}

export function useNotificationsCtx(): NotifState {
  const v = React.useContext(NotifCtx);
  if (!v) throw new Error("NotificationsProvider missing");
  return v;
}

export function NotifBell({ onClick, count }: { onClick: () => void; count: number }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn ghost sm relative" onClick={onClick} aria-label={count ? t("notif.bellUnread", { count }) : t("nav.notificari")}>
      <Bell className="size-4" />
      {count > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-warn text-2xs font-bold text-warning-fg grid place-items-center px-1" aria-hidden>{count > 9 ? "9+" : count}</span>}
    </button>
  );
}

export function Notificari({ focusId }: { focusId?: string | null }) {
  const { t } = useTranslation();
  const { cards, loaded, error, reload, api: n } = useNotificationsCtx();
  const [tab, setTab] = React.useState<"open" | "history" | "settings">("open");
  const [history, setHistory] = React.useState<NotifyCard[] | null>(null);
  const [histErr, setHistErr] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<string>("all");
  const loadHistory = React.useCallback(() => {
    setHistErr(null);
    n.list(true).then((r) => setHistory(r.cards.filter((c) => c.dismissedAt))).catch((e) => setHistErr(String(e).replace(/^Error:\s*/, "")));
  }, [n]);
  React.useEffect(() => { if (tab === "history") loadHistory(); }, [tab, loadHistory]);
  // opening the page marks what is visible as read
  React.useEffect(() => {
    const unread = cards.filter((c) => !c.readAt).map((c) => c.id);
    if (unread.length) void n.op({ op: "read", ids: unread }).then(reload).catch(() => undefined);
  }, [cards, n, reload]);
  React.useEffect(() => {
    if (!focusId) return;
    document.getElementById(`n-${focusId}`)?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [focusId, cards]);

  const kinds = Array.from(new Set(cards.map((c) => c.kind)));
  const shown = filter === "all" ? cards : cards.filter((c) => c.kind === filter);
  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.notificari")}
        actions={<Seg value={tab} onChange={setTab} options={[{ id: "open", label: cards.length ? `${t("notif.active")} · ${cards.length}` : t("notif.active") }, { id: "history", label: t("notif.history") }, { id: "settings", label: t("notif.settings"), icon: <Settings2 className="size-4" /> }]} />} />
      {tab === "open" && (
        <>
          {kinds.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              <Chip on={filter === "all"} onClick={() => setFilter("all")}>{t("notif.all")}</Chip>
              {kinds.map((k) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>{kindLabel(k)}</Chip>)}
              {cards.some((c) => !c.sticky) && <button type="button" className="btn ghost sm ml-auto" onClick={() => n.op({ op: "dismissAll" }).then(reload)}><Trash2 className="size-3.5" />{t("notif.clear")}</button>}
            </div>
          )}
          {!loaded ? (error ? <ErrorState title={t("notif.loadFailed")} error={error} onRetry={() => void reload()} /> : <Loading />) : shown.length === 0 ? (
            <EmptyState title={t("notif.empty")} illustration="notifications" />
          ) : (
            <div className="grid gap-2.5">{shown.map((c) => <NotifCardView key={c.id} card={c} focus={c.id === focusId} onAct={(a) => act(n, c, a, reload)} onDismiss={() => n.op({ op: "dismiss", id: c.id }).then(reload)} />)}</div>
          )}
        </>
      )}
      {tab === "history" && (
        <div className="grid gap-1.5">
          {history == null && (histErr ? <ErrorState title={t("notif.loadFailed")} error={histErr} onRetry={loadHistory} /> : <Loading />)}
          {history?.length === 0 && <EmptyState title={t("notif.historyEmpty")} illustration="search" compact />}
          {history?.map((c) => (
            <div key={c.id} className="glass flex items-center gap-3 px-3 py-2 opacity-80">
              <KindDot kind={c.kind} color={c.color} />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate" title={c.title}>{c.title}</div>
                <div className="text-xs text-muted truncate">{fmtWhen(c.createdAt)} · {c.actedWith ? `${c.actedWith} · ${c.actedBy ?? ""}` : c.fallbackAt ? t("notif.viaHa") : c.deliveredTo ? t("notif.deliveredTo", { to: c.deliveredTo }) : t("notif.expired")}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === "settings" && <NotifSettings />}
    </div>
  );
}

const kindLabel = (k: string) => tx(`notif.kind.${k}`, k);

async function act(n: ReturnType<typeof useNotifyApi>, c: NotifyCard, a: NotifyAction, reload: () => void) {
  if (a.url) {
    void n.op({ op: "read", ids: [c.id] });
    try { await openUrl(a.url); } catch (e) { toast("error", i18n.t("notif.cantOpen", { url: a.url, error: String(e) })); }
    return;
  }
  try {
    const r = await n.act(c.id, a.id);
    if (r.ok) toast("ok", r.message ?? i18n.t("common.done")); else toast("error", r.error ?? i18n.t("common.failed"));
  } catch (e) {
    toast("error", String(e));
  }
  reload();
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={on} className={cn("btn ghost sm rounded-full", on && "on")} onClick={onClick}>{children}</button>;
}

function KindDot({ kind, color }: { kind: string; color: string | null }) {
  const I = ICON[kind] ?? Info;
  const c = color ?? FALLBACK;
  return (
    <span className="size-9 shrink-0 rounded-full grid place-items-center" style={{ background: tint(c), color: c }}>
      <I className="size-4.5" />
    </span>
  );
}

export function NotifCardView({ card: c, focus, onAct, onDismiss, compact }: { card: NotifyCard; focus?: boolean; onAct: (a: NotifyAction) => void; onDismiss: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const color = c.color ?? FALLBACK;
  return (
    <article
      id={`n-${c.id}`}
      className={cn("glass relative overflow-hidden transition-shadow", focus && "ring-2 ring-fg/40", c.priority === "urgent" && "border-down/60", !c.readAt && "border-l-2")}
      style={{ borderLeftColor: !c.readAt ? color : undefined, boxShadow: c.priority === "urgent" ? `0 0 0 1px ${tint(color, 40)}, 0 12px 40px -18px ${color}` : undefined }}
    >
      {c.image && !compact && (
        <div className="relative h-36 -mb-6">
          <img src={c.image} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-linear-to-b from-transparent via-bg/30 to-bg" />
        </div>
      )}
      <div className="relative flex gap-3 px-3.5 py-3">
        <KindDot kind={c.kind} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[15px] font-semibold leading-tight truncate" title={c.title}>{c.title}</h3>
            <span className="ml-auto shrink-0 text-xs text-muted tabular-nums">{fmtWhen(c.updatedAt)}</span>
          </div>
          {c.subtitle && <div className="text-xs mt-0.5" style={{ color }}>{c.subtitle}</div>}
          {c.body && <p className="text-sm text-muted mt-1 whitespace-pre-line leading-snug line-clamp-4">{c.body}</p>}
          {c.progress != null && (
            <div className="mt-2 h-1.5 rounded-full bg-fg/10 overflow-hidden" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${c.progress}%`, background: color }} />
            </div>
          )}
          {(c.actions.length > 0 || !c.sticky) && (
            <div className="mt-2.5 flex gap-1.5 flex-wrap">
              {c.actions.map((a) => (
                <button key={a.id} type="button" className={cn("btn sm", a.style === "primary" && "primary", a.style === "danger" && "danger", a.style === "ghost" && "ghost")} style={a.style === "primary" ? { background: color, borderColor: color, color: "var(--color-bg)" } : undefined} onClick={() => onAct(a)}>
                  {a.id === "approve" && <Check className="size-3.5" />}
                  {a.id === "reject" && <X className="size-3.5" />}
                  {a.label}
                </button>
              ))}
              {!c.sticky && <button type="button" className="btn ghost sm ml-auto" onClick={onDismiss} aria-label={t("common.close")}><X className="size-3.5" /></button>}
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
  if (diff < 60) return i18n.t("time.now");
  if (diff < 3600) return i18n.t("time.min", { n: Math.floor(diff / 60) });
  if (diff < 86400 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(currentLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function NotifSettings() {
  const { t } = useTranslation();
  const n = useNotifyApi();
  const [s, setS] = React.useState<Settings | null>(null);
  const [meta, setMeta] = React.useState<Meta>({});
  const [fcm, setFcm] = React.useState<boolean | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    setErr(null);
    n.settings().then((r) => { setS(r.settings); if (r.meta) setMeta(r.meta); if (typeof r.fcm === "boolean") setFcm(r.fcm); }).catch((e) => setErr(String(e).replace(/^Error:\s*/, "")));
  }, [n]);
  React.useEffect(() => load(), [load]);
  if (!s) return err ? <ErrorState title={t("notif.loadFailed")} error={err} onRetry={load} /> : <Loading />;
  const patch = (f: (x: Settings) => Settings) => { setS((x) => (x ? f(x) : x)); setDirty(true); };
  const save = () => n.settings(s).then(() => { toast("ok", t("common.saved")); setDirty(false); }).catch((e) => toast("error", String(e)));
  return (
    <div className="grid gap-4">
      <Card title={t("notif.quiet")} sub={t("notif.quietSub")}>
        <Row label={t("notif.quietOn")}><Switch checked={s.quiet.enabled} onChange={(v) => patch((x) => ({ ...x, quiet: { ...x.quiet, enabled: v } }))} label={t("notif.quiet")} /></Row>
        <Row label={t("notif.from")}><input className="input w-28" type="time" aria-label={t("notif.from")} value={s.quiet.from} onChange={(e) => patch((x) => ({ ...x, quiet: { ...x.quiet, from: e.target.value } }))} /></Row>
        <Row label={t("notif.to")}><input className="input w-28" type="time" aria-label={t("notif.to")} value={s.quiet.to} onChange={(e) => patch((x) => ({ ...x, quiet: { ...x.quiet, to: e.target.value } }))} /></Row>
      </Card>
      <Card title={t("notif.kinds")} sub={t("notif.kindsSub")}>
        <div className="grid gap-1">
          {Object.entries(s.kinds).map(([k, v]) => {
            const I = ICON[k] ?? Info;
            const c = v.color ?? meta[k]?.color ?? FALLBACK;
            const label = meta[k]?.label ?? kindLabel(k);
            return (
              <div key={k} className="flex items-center gap-3 py-1.5">
                <span className="size-8 shrink-0 rounded-full grid place-items-center" style={{ background: tint(c), color: c }}><I className="size-4" /></span>
                <div className="min-w-0 flex-1 text-sm">{label}</div>
                <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={v.breakQuiet} onChange={(e) => patch((x) => ({ ...x, kinds: { ...x.kinds, [k]: { ...v, breakQuiet: e.target.checked } } }))} />{t("notif.atNight")}</label>
                <Switch checked={v.enabled} label={label} onChange={(on) => patch((x) => ({ ...x, kinds: { ...x.kinds, [k]: { ...v, enabled: on } } }))} />
              </div>
            );
          })}
        </div>
      </Card>
      <Card title={t("notif.delivery")}>
        <Row label={t("notif.fcm")} hint={fcm === false ? t("notif.fcmMissing") : t("notif.fcmHint")}><Switch checked={s.fcm.enabled} onChange={(v) => patch((x) => ({ ...x, fcm: { enabled: v } }))} label={t("notif.fcm")} /></Row>
        <Row label={t("notif.haFallback")} hint={t("notif.haFallbackHint")}><Switch checked={s.haFallback} onChange={(v) => patch((x) => ({ ...x, haFallback: v }))} label={t("notif.haFallback")} /></Row>
        <Row label={t("notif.water")} hint={t("notif.waterHint")}><input className="input w-24" type="number" aria-label={t("notif.water")} min={0} max={1000} step={50} value={s.waterNudgeMl} onChange={(e) => patch((x) => ({ ...x, waterNudgeMl: Number(e.target.value) }))} /> <span className="text-xs text-muted">ml</span></Row>
        <Row label={t("notif.battery")}><input className="input w-20" type="number" aria-label={t("notif.battery")} min={5} max={50} value={s.batteryBelow} onChange={(e) => patch((x) => ({ ...x, batteryBelow: Number(e.target.value) }))} /> <span className="text-xs text-muted">%</span></Row>
      </Card>
      {dirty && (
        <div className="sticky bottom-2 flex justify-end">
          <button type="button" className="btn primary" onClick={save}>{t("common.save")}</button>
        </div>
      )}
    </div>
  );
}
