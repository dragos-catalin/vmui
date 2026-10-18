import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Activity, Bell, Cpu, Home, Lightbulb, Lamp, Minus, MonitorSmartphone, Settings, Settings2, SlidersHorizontal, Square, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { api, cn, useEvent, useToasts, type Health } from "./lib";
import { Ambilight } from "./pages/Ambilight";
import { Casa } from "./pages/Casa";
import { PendingBanner } from "./pages/Devices";
import { Dispozitive } from "./pages/Dispozitive";
import { Ecrane } from "./pages/Ecrane";
import { Lumini } from "./pages/Lumini";
import { NotifBell, Notificari, useNotifications } from "./pages/Notificari";
import { Pc } from "./pages/Pc";
import { Servicii } from "./pages/Servicii";
import { Setari } from "./pages/Setari";
import { Setup } from "./pages/Setup";
import { UpdateBanner } from "./pages/Update";
import { PlatformProvider, useAppInfo, usePlatform } from "./platform";

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

export function App() {
  const { info, refresh } = useAppInfo();
  if (!info) return <div className="bg-scene h-full" />;
  return (
    <PlatformProvider value={info}>
      <Shell onConfigured={refresh} />
    </PlatformProvider>
  );
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
  useEvent<Health>("health", setHealth);
  const poll = React.useCallback(() => api.health().then(setHealth).catch(() => undefined), []);
  React.useEffect(() => {
    void poll();
    // desktop pushes `health` events from the tray loop; the phone has no loop, so poll
    if (!mobile) return;
    const id = setInterval(() => document.visibilityState === "visible" && void poll(), 10000);
    return () => clearInterval(id);
  }, [mobile, poll]);
  React.useEffect(() => localStorage.setItem("vmui:page", page), [page]);
  const [focusNotif, setFocusNotif] = React.useState<string | null>(null);
  const { cards } = useNotifications();
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

  if (mobile && (!vmui || setup)) return <Setup onDone={() => { setSetup(false); onConfigured(); void poll(); }} canCancel={!!vmui} onCancel={() => setSetup(false)} />;

  const el = (() => {
    switch (page) {
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
  })();
  const label = (p: PageId) => t(`nav.${p}`);
  const detail = health?.detail ?? t("app.connecting");
  return (
    <HealthCtx.Provider value={health}>
      {mobile ? (
        <div className="bg-scene h-full grid grid-rows-[auto_1fr_auto]" style={{ paddingTop: "max(env(safe-area-inset-top), 28px)" }}>
          <header className="flex items-center gap-2.5 px-4 pt-2 pb-2 text-sm font-semibold">
            <span className={cn("dot", health?.state === "ok" && "text-ok bg-ok", health?.state === "warn" && "text-warn bg-warn", (!health || health.state === "down") && "text-down bg-down")} />
            vmui <span className="font-normal text-muted truncate">· {detail}</span>
            <span className="ml-auto flex items-center">
              <NotifBell count={unread} onClick={() => openNotif()} />
              <button type="button" className="btn ghost sm" onClick={() => setSetup(true)} aria-label={t("app.connection")}><Settings2 className="size-4" /></button>
            </span>
          </header>
          <main className="min-h-0 overflow-y-auto px-4 pb-4">
            <UpdateBanner />
            <PendingBanner />
            <div key={page} className="page">{el}</div>
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
        </div>
      ) : (
        <div className="bg-scene h-full grid grid-rows-[40px_1fr]">
          <TitleBar health={health} detail={detail} unread={unread} onBell={() => openNotif()} />
          <div className="grid grid-cols-[212px_1fr] min-h-0">
            <nav className="nav flex flex-col gap-1 p-3 pt-1" aria-label={t("app.pages")}>
              {pages.map((p) => (
                <button key={p} type="button" className={cn(p === page && "on")} onClick={() => setPage(p)} aria-current={p === page ? "page" : undefined}>
                  {ICONS[p]}
                  {label(p)}
                  {p === "notificari" && unread > 0 && <span className="ml-auto text-[11px] tabular-nums text-warn">{unread}</span>}
                  {p === "sistem" && health && health.state !== "ok" && <span className={cn("dot ml-auto", health.state === "warn" ? "text-warn bg-warn" : "text-down bg-down")} />}
                </button>
              ))}
              <div className="mt-auto px-3 pb-1 text-[11px] text-dim leading-5">
                <div className="flex items-center gap-2"><span className={cn("dot", health?.vmui ? "text-ok bg-ok" : "text-down bg-down")} />vmui</div>
                <div className="flex items-center gap-2"><span className={cn("dot", health?.ha ? "text-ok bg-ok" : "text-down bg-down")} />Home Assistant</div>
                <div className="flex items-center gap-2"><span className={cn("dot", health?.hyper ? "text-ok bg-ok" : "text-down bg-down")} />HyperHDR</div>
              </div>
            </nav>
            <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-1">
              <div className="mx-auto max-w-[1080px]"><PendingBanner /></div>
              <div key={page} className="page mx-auto max-w-[1080px]">{el}</div>
            </main>
          </div>
          <Toasts />
        </div>
      )}
    </HealthCtx.Provider>
  );
}

function TitleBar({ health, detail, unread, onBell }: { health: Health | null; detail: string; unread: number; onBell: () => void }) {
  const { t } = useTranslation();
  const w = getCurrentWindow();
  const tone = health?.state ?? "warn";
  return (
    <header data-tauri-drag-region className="flex items-center gap-3 px-4 select-none" onDoubleClick={() => void w.toggleMaximize()}>
      <div data-tauri-drag-region className="flex items-center gap-2.5 text-sm font-semibold">
        <span className={cn("dot", tone === "ok" && "text-ok bg-ok", tone === "warn" && "text-warn bg-warn", tone === "down" && "text-down bg-down")} />
        vmui
        <span className="font-normal text-muted">· {detail}</span>
      </div>
      <div className="ml-auto flex items-center">
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
  const list = useToasts();
  useEvent<{ kind: "ok" | "error" | "info"; text: string }>("toast", (t) => import("./lib").then((m) => m.toast(t.kind, t.text)));
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 left-4 flex flex-col items-end gap-2 md:bottom-4 md:left-auto" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={cn("glass px-4 py-2.5 text-sm", t.kind === "error" && "border-down/50 text-down", t.kind === "ok" && "border-ok/40")}>{t.text}</div>
      ))}
    </div>
  );
}
