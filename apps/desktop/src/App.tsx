import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Activity, Bell, Cpu, Home, Lightbulb, Lamp, Minus, MonitorSmartphone, Settings, Settings2, SlidersHorizontal, Square, X } from "lucide-react";
import * as m from "motion/react-m";
import { LazyMotion, MotionConfig, domAnimation, useAnimate, useReducedMotion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { VatraMark } from "./brand/VatraMark";
import { PendingBanner } from "./components/paired-devices";
import { api, cn, dismissToast, PageActiveCtx, toast, useEvent, useInterval, useToasts, type Health } from "./lib";
import { Ambilight } from "./pages/Ambilight";
import { Casa } from "./pages/Casa";
import { Dispozitive } from "./pages/Dispozitive";
import { Ecrane } from "./pages/Ecrane";
import { Lumini } from "./pages/Lumini";
import { NotifBell, Notificari, NotificationsProvider, useNotificationsCtx } from "./pages/Notificari";
import { Pc } from "./pages/Pc";
import { Servicii } from "./pages/Servicii";
import { Setari } from "./pages/Setari";
import { Setup } from "./pages/Setup";
import { UpdateBanner } from "./pages/Update";
import { PlatformProvider, useAppInfo, usePlatform, type AppInfo } from "./platform";
import { ConfirmHost, ErrorBoundary } from "./ui";

type PageId = "casa" | "lumini" | "dispozitive" | "ambilight" | "ecrane" | "notificari" | "pc" | "sistem" | "setari";
const ALL: PageId[] = ["casa", "lumini", "dispozitive", "ambilight", "ecrane", "notificari", "pc", "sistem", "setari"];
const MOBILE: PageId[] = ["casa", "lumini", "ambilight", "pc", "sistem"];
const ICONS: Record<PageId, React.ReactNode> = {
  casa: <Home className="size-4" />,
  lumini: <Lamp className="size-4" />,
  dispozitive: <SlidersHorizontal className="size-4" />,
  ambilight: <Lightbulb className="size-4" />,
  ecrane: <MonitorSmartphone className="size-4" />,
  notificari: <Bell className="size-4" />,
  pc: <Cpu className="size-4" />,
  sistem: <Activity className="size-4" />,
  setari: <Settings className="size-4" />,
};
// "servicii" was the old id of "sistem"; keep stored pages and vmui:// links working
const normalize = (p: string | null | undefined): PageId | null => (p === "servicii" ? "sistem" : ALL.includes(p as PageId) ? (p as PageId) : null);

export const HealthCtx = React.createContext<Health | null>(null);
/** Re-check health now (tray loop runs every 15 s visible / 60 s hidden); `busy` while it runs. */
export const HealthRefreshCtx = React.createContext<{ refresh: () => void; busy: boolean }>({ refresh: () => undefined, busy: false });

export function App({ info: initial }: { info?: AppInfo }) {
  const { info, refresh } = useAppInfo(initial);
  if (!info) return <div className="bg-scene h-full" />;
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <PlatformProvider value={info}>
          <NotificationsProvider>
            <Shell onConfigured={refresh} />
          </NotificationsProvider>
        </PlatformProvider>
      </MotionConfig>
    </LazyMotion>
  );
}

function renderPage(p: PageId, focusNotif: string | null) {
  switch (p) {
    case "casa": return <Casa />;
    case "lumini": return <Lumini />;
    case "dispozitive": return <Dispozitive />;
    case "ambilight": return <Ambilight />;
    case "ecrane": return <Ecrane />;
    case "notificari": return <Notificari focusId={focusNotif} />;
    case "pc": return <Pc />;
    case "sistem": return <Servicii />;
    case "setari": return <Setari />;
  }
}

/** Every visited page stays mounted (state + data survive navigation, DK-10); only the active one is shown and polls. */
function Pages({ page, pages, focusNotif, className }: { page: PageId; pages: PageId[]; focusNotif: string | null; className?: string }) {
  const [visited, setVisited] = React.useState<PageId[]>([page]);
  React.useEffect(() => setVisited((v) => (v.includes(page) ? v : [...v, page])), [page]);
  return (
    <>
      {pages.filter((p) => visited.includes(p) || p === page).map((p) => (
        <PageActiveCtx.Provider key={p} value={p === page}>
          <Pane active={p === page} className={className}>
            <ErrorBoundary scope={p}>{renderPage(p, focusNotif)}</ErrorBoundary>
          </Pane>
        </PageActiveCtx.Provider>
      ))}
    </>
  );
}

/** Kept-mounted page: hidden when inactive; on activation it fades in with an 8 px rise (220 ms, ease-out). */
function Pane({ active, className, children }: { active: boolean; className?: string; children: React.ReactNode }) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();
  React.useEffect(() => {
    if (active && !reduce && scope.current) void animate(scope.current, { opacity: [0, 1], y: [8, 0] }, { duration: 0.22, ease: [0.16, 1, 0.3, 1] });
  }, [active, reduce, animate, scope]);
  return <div ref={scope} hidden={!active} className={className}>{children}</div>;
}

function Shell({ onConfigured }: { onConfigured: () => void }) {
  const { t } = useTranslation();
  const { mobile, vmui } = usePlatform();
  const pages = mobile ? MOBILE : ALL;
  const [page, setPageRaw] = React.useState<PageId>(() => {
    const p = normalize(localStorage.getItem("vmui:page"));
    return p && (mobile ? MOBILE.includes(p) || p === "notificari" : true) ? p : mobile ? "casa" : "ambilight";
  });
  const setPage = React.useCallback((p: PageId) => setPageRaw(mobile && !MOBILE.includes(p) && p !== "notificari" ? "casa" : p), [mobile]);
  const [setup, setSetup] = React.useState(false);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [checking, setChecking] = React.useState(false);
  useEvent<Health>("health", setHealth);
  const poll = React.useCallback((fresh = false) => {
    if (fresh) setChecking(true);
    return api.health(fresh).then(setHealth).catch(() => undefined).finally(() => setChecking(false));
  }, []);
  React.useEffect(() => void poll(), [poll]);
  // desktop pushes `health` events from the tray loop; the phone has no loop, so poll while visible
  useInterval(() => void poll(), mobile ? 10000 : null);
  const healthRefresh = React.useMemo(() => ({ refresh: () => void poll(true), busy: checking }), [poll, checking]);
  React.useEffect(() => localStorage.setItem("vmui:page", page), [page]);
  const [focusNotif, setFocusNotif] = React.useState<string | null>(null);
  const { cards } = useNotificationsCtx();
  const unread = cards.filter((c) => !c.readAt).length;
  const openNotif = React.useCallback((id?: string | null) => { setFocusNotif(id ?? null); setPage("notificari"); }, [setPage]);
  // desktop: tray menu / toast tap -> Rust emits `navigate`; mobile: Android wrote the vmui:// link, read it when we come to the front
  useEvent<{ page: string; id?: string }>("navigate", (n) => {
    if (n.page === "notificari") return openNotif(n.id);
    const p = normalize(n.page);
    if (p) setPage(p);
  });
  React.useEffect(() => {
    if (!mobile) return;
    const check = () => invoke<string | null>("pending_link").then((l) => {
      if (!l) return;
      const u = new URL(l);
      const seg = u.pathname.replace(/^\/+/, "");
      if (u.host === "notifications") openNotif(seg || null);
      else { const p = normalize(u.host); if (p) setPage(p); }
    }).catch(() => undefined);
    void check();
    const on = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [mobile, openNotif, setPage]);

  if (mobile && (!vmui || setup)) return <Setup onDone={() => { setSetup(false); onConfigured(); void poll(true); }} canCancel={!!vmui} onCancel={() => setSetup(false)} />;

  const label = (p: PageId) => t(`nav.${p}`);
  const detail = health?.detail ?? t("app.connecting");
  return (
    <HealthCtx.Provider value={health}>
      <HealthRefreshCtx.Provider value={healthRefresh}>
        {mobile ? (
          <div className="bg-scene h-full grid grid-rows-[auto_1fr_auto]" style={{ paddingTop: "max(env(safe-area-inset-top), 28px)" }}>
            <header className="flex min-w-0 items-center gap-2.5 px-4 pt-2 pb-2 text-sm font-semibold">
              <BrandMark health={health} busy={checking} />
              <span className="font-display">Vatra</span>
              <span className="min-w-0 truncate font-normal text-muted" title={detail}>· {detail}</span>
              <span className="ml-auto flex shrink-0 items-center">
                <NotifBell count={unread} onClick={() => openNotif()} />
                <button type="button" className="btn ghost sm" onClick={() => setSetup(true)} aria-label={t("app.connection")}><Settings2 className="size-4" /></button>
              </span>
            </header>
            <main className="min-h-0 overflow-y-auto px-4 pb-4">
              <UpdateBanner />
              <PendingBanner />
              <Pages page={page} pages={pages} focusNotif={focusNotif} />
            </main>
            <nav className="tabs" aria-label={t("app.pages")} style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}>
              {pages.map((p) => (
                <button key={p} type="button" className={cn(p === page && "on")} onClick={() => setPage(p)} aria-current={p === page ? "page" : undefined}>
                  {ICONS[p]}
                  <span>{p === "sistem" ? t("nav.pi") : label(p)}</span>
                </button>
              ))}
            </nav>
            <Toasts />
            <ConfirmHost />
          </div>
        ) : (
          <div className="bg-scene h-full grid grid-rows-[40px_1fr]">
            <TitleBar health={health} busy={checking} detail={detail} unread={unread} onBell={() => openNotif()} />
            <div className="grid grid-cols-[212px_1fr] min-h-0">
              <nav className="nav flex min-h-0 flex-col gap-1 overflow-y-auto p-3 pt-1" aria-label={t("app.pages")}>
                {pages.map((p) => (
                  <button key={p} type="button" className={cn(p === page && "on")} onClick={() => setPage(p)} aria-current={p === page ? "page" : undefined}>
                    {ICONS[p]}
                    <span className="min-w-0 truncate">{label(p)}</span>
                    {p === "notificari" && unread > 0 && <span className="ml-auto text-xs tabular-nums text-warning-text" aria-label={t("notif.bellUnread", { count: unread })}>{unread}</span>}
                    {p === "sistem" && health && health.state !== "ok" && <span className={cn("dot ml-auto", health.state === "warn" ? "text-warn bg-warn" : "text-down bg-down")} aria-label={t(health.state === "warn" ? "app.stateWarn" : "app.stateDown")} />}
                  </button>
                ))}
                <div className="mt-auto px-3 pb-1 text-xs text-muted leading-6">
                  <ServiceDot ok={health?.vmui} name="Vatra server" />
                  <ServiceDot ok={health?.ha} name="Home Assistant" />
                  <ServiceDot ok={health?.hyper} name="HyperHDR" />
                </div>
              </nav>
              <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-1">
                <div className="mx-auto max-w-[1080px]"><PendingBanner /></div>
                <Pages page={page} pages={pages} focusNotif={focusNotif} className="mx-auto max-w-[1080px]" />
              </main>
            </div>
            <Toasts />
            <ConfirmHost />
          </div>
        )}
      </HealthRefreshCtx.Provider>
    </HealthCtx.Provider>
  );
}

function ServiceDot({ ok, name }: { ok: boolean | undefined; name: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <span className={cn("dot", ok ? "text-ok bg-ok" : "text-down bg-down")} aria-hidden />
      {name}<span className="sr-only">: {ok ? t("app.serviceUp") : t("app.serviceDown")}</span>
    </div>
  );
}

/** Status lives in the mark: thinking while health loads/refreshes, error when down, a dot badge for warn. */
function BrandMark({ health, busy }: { health: Health | null; busy: boolean }) {
  const { t } = useTranslation();
  const state = !health || busy ? "thinking" : health.state === "down" ? "error" : "static";
  const label = !health ? t("app.connecting") : t(health.state === "ok" ? "app.stateOk" : health.state === "warn" ? "app.stateWarn" : "app.stateDown");
  return (
    <span className="relative inline-flex shrink-0" data-tauri-drag-region>
      <span data-brand-mark className="inline-flex"><VatraMark size={18} state={state} label={`Vatra · ${label}`} /></span>
      {health?.state === "warn" && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warn ring-2 ring-bg" aria-hidden />}
    </span>
  );
}

function TitleBar({ health, busy, detail, unread, onBell }: { health: Health | null; busy: boolean; detail: string; unread: number; onBell: () => void }) {
  const { t } = useTranslation();
  const w = getCurrentWindow();
  return (
    <header data-tauri-drag-region className="flex min-w-0 items-center gap-3 px-4 select-none" onDoubleClick={() => void w.toggleMaximize()}>
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2.5 text-sm font-semibold">
        <BrandMark health={health} busy={busy} />
        <span data-tauri-drag-region className="font-display">Vatra</span>
        <span data-tauri-drag-region className="min-w-0 truncate font-normal text-muted" title={detail}>· {detail}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center">
        <NotifBell count={unread} onClick={onBell} />
        <span className="w-2" />
        <button type="button" className="btn ghost sm" aria-label={t("app.minimize")} onClick={() => void w.minimize()}><Minus className="size-4" /></button>
        <button type="button" className="btn ghost sm" aria-label={t("app.maximize")} onClick={() => void w.toggleMaximize()}><Square className="size-3.5" /></button>
        <button type="button" className="btn ghost sm hover:text-down" aria-label={t("app.closeToTray")} onClick={() => void w.hide()}><X className="size-4" /></button>
      </div>
    </header>
  );
}

function Toasts() {
  const { t } = useTranslation();
  const list = useToasts();
  useEvent<{ kind: "ok" | "error" | "info"; text: string }>("toast", (x) => toast(x.kind, x.text));
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 left-4 z-[var(--z-toast)] flex flex-col items-end gap-2 md:bottom-4 md:left-auto">
      {list.map((x) => (
        <m.div key={x.id} role={x.kind === "error" ? "alert" : "status"} aria-live={x.kind === "error" ? "assertive" : "polite"}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className={cn("glass float pointer-events-auto flex max-w-sm items-start gap-2 py-2.5 pl-4 pr-2 text-sm", x.kind === "error" && "border-down/50 text-down", x.kind === "ok" && "border-ok/40")}>
          <span className="min-w-0 flex-1 break-words">{x.text}</span>
          <button type="button" className="btn ghost sm -my-1 shrink-0 px-1.5" aria-label={t("common.close")} onClick={() => dismissToast(x.id)}><X className="size-3.5" /></button>
        </m.div>
      ))}
    </div>
  );
}
