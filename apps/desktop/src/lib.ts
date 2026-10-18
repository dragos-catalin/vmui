import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";
import type { BleStatus, Discovered, LightsPayload } from "./lights";

export type Health = {
  state: "ok" | "warn" | "down";
  detail: string;
  vmui: boolean;
  ha: boolean;
  hyper: boolean;
  grabber: boolean | null;
  source: string;
  tasks: TaskState[];
};
export type TaskState = { name: string; status: string; running: boolean };
export type HyperInstance = { id: number; name: string; running: boolean; grabber: boolean | null; source: string; brightness: number | null; effects: string[] };
export type Ent = { state: string; attributes: Record<string, unknown> };

export const api = {
  /** Cached tray-loop result; `fresh` re-checks now (and the tray emits `health` to every listener). */
  health: (fresh = false) => invoke<Health>("health", { fresh }),
  tasks: () => invoke<TaskState[]>("tasks"),
  taskAction: (name: string, action: "start" | "stop" | "restart") => invoke<void>("task_action", { name, action }),
  tailLog: (name: string, lines = 200) => invoke<string>("tail_log", { name, lines }),
  openPath: (what: "settings" | "logs" | "root") => invoke<void>("open_path", { what }),
  settingsGet: () => invoke<Record<string, unknown>>("settings_get"),
  settingsSet: (patch: Record<string, unknown>) => invoke<Record<string, unknown>>("settings_set", { patch }),
  ambilightConfigure: () => invoke<string>("ambilight_configure"),
  hyperInstances: () => invoke<HyperInstance[]>("hyper_instances"),
  hyperSend: (commands: unknown[], instances?: number[]) => invoke<string[]>("hyper_send", { commands, instances }),
  ambilightMode: (mode: "movie" | "music" | "off") => invoke<void>("ambilight_mode", { mode }),
  pcAction: (action: string, value?: number) => invoke<string>("pc_action", { action, value }),
  haCall: (domain: string, service: string, data: Record<string, unknown>) => invoke<unknown>("ha_call", { domain, service, data }),
  vmuiGet: <T = unknown>(path: string) => invoke<T>("vmui_get", { path }),
  vmuiSend: <T = unknown>(method: "POST" | "PUT", path: string, body: unknown) => invoke<T>("vmui_send", { method, path, body }),
  appInfo: () => invoke<{ root: string; vmui: string; haUrl: string; displayUrl: string; version: string }>("app_info"),
  lightsGet: () => invoke<LightsPayload>("lights_get"),
  lightsOp: <T = unknown>(body: Record<string, unknown>) => invoke<T>("lights_op", { body }),
  bleScan: (seconds = 8) => invoke<Discovered[]>("ble_scan", { seconds }),
  bleStatus: () => invoke<BleStatus[]>("ble_status"),
  langGet: () => invoke<"ro" | "en">("lang_get"),
  langSet: (lang: "ro" | "en") => invoke<void>("lang_set", { lang }),
  piStatus: <T = unknown>(log?: string) => invoke<T>("pi_status", log ? { log } : {}),
};

/** Subscribe to a Rust-emitted event; unsubscribes on unmount. */
export function useEvent<T>(name: string, cb: (payload: T) => void) {
  const ref = React.useRef(cb);
  ref.current = cb;
  React.useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    void listen<T>(name, (e) => ref.current(e.payload)).then((u) => (alive ? (un = u) : u()));
    return () => {
      alive = false;
      un?.();
    };
  }, [name]);
}

/* ------------------------------------------------- window + page activity */
// WebView2 does not always report `visibilityState=hidden` when the window goes to the tray,
// so Rust also emits `visibility` (and app_ready tells us about a `--hidden` start).
let winVisible = true;
const visSubs = new Set<() => void>();
export function setWindowVisible(v: boolean) {
  if (winVisible === v) return;
  winVisible = v;
  visSubs.forEach((s) => s());
}
const subscribeVis = (cb: () => void) => {
  visSubs.add(cb);
  document.addEventListener("visibilitychange", cb);
  return () => { visSubs.delete(cb); document.removeEventListener("visibilitychange", cb); };
};
const getVis = () => winVisible && document.visibilityState === "visible";
export function useWindowVisible() {
  return React.useSyncExternalStore(subscribeVis, getVis, () => true);
}
if ("__TAURI_INTERNALS__" in window) void listen<boolean>("visibility", (e) => setWindowVisible(e.payload)).catch(() => undefined);

/** False while the page is kept mounted but not shown (App keeps visited pages alive). */
export const PageActiveCtx = React.createContext(true);
/** The page is on screen: shown, and the window is visible. Pollers run only then. */
export function useActive() {
  return React.useContext(PageActiveCtx) && useWindowVisible();
}

/** setInterval that only fires while active, and fires once right away when it becomes active again. */
export function useInterval(fn: () => void, ms: number | null) {
  const active = useActive();
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => {
    if (!active || ms == null) return;
    ref.current();
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

const pollCache = new Map<string, { data: unknown; at: number; p?: Promise<unknown> }>();

/** Poll an async getter every `ms` while the page is active. `key` shares the result (and one in-flight
 *  request) between pages that read the same endpoint. `stale` = last refresh failed but old data is shown. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = [], key?: string) {
  const [data, setData] = React.useState<T | null>(() => (key ? ((pollCache.get(key)?.data as T | undefined) ?? null) : null));
  const [error, setError] = React.useState<string | null>(null);
  const tick = React.useCallback(async (force = true) => {
    try {
      let v: T;
      const c = key ? pollCache.get(key) : undefined;
      if (key && c?.p) v = (await c.p) as T;
      else if (key && c && !force && Date.now() - c.at < ms * 0.8) v = c.data as T;
      else {
        const p = fn();
        if (key) pollCache.set(key, { data: c?.data, at: c?.at ?? 0, p });
        try { v = await p; } catch (e) { if (key) pollCache.set(key, { data: c?.data, at: c?.at ?? 0 }); throw e; }
        if (key) pollCache.set(key, { data: v, at: Date.now() });
      }
      setData(v);
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useInterval(() => void tick(false), ms);
  const refresh = React.useCallback(() => tick(true), [tick]);
  return { data, error, stale: !!error && data != null, refresh, setData };
}

/* ----------------------------------------------------------- toasts */
type Toast = { id: number; kind: "ok" | "error" | "info"; text: string };
const listeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
export function dismissToast(id: number) {
  toasts = toasts.filter((x) => x.id !== id);
  listeners.forEach((l) => l(toasts));
}
export function toast(kind: Toast["kind"], text: string) {
  const t = { id: Date.now() + Math.random(), kind, text };
  toasts = [...toasts, t].slice(-4);
  listeners.forEach((l) => l(toasts));
  // errors stay long enough to read (and have a close button)
  setTimeout(() => dismissToast(t.id), kind === "error" ? 8000 : 3600);
}
/** prefers-reduced-motion, for imperative scrolls / animations. */
export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export function useToasts() {
  const [list, setList] = React.useState<Toast[]>(toasts);
  React.useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/** Run an action with a busy flag and toast on failure. */
export function useAction() {
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(async (key: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okText) toast("ok", okText);
    } catch (e) {
      toast("error", String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
/** Structural equality with sorted object keys (settings.json comes back in file order). */
export function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => p.localeCompare(q))) : x));
  return canon(a) === canon(b);
}
export const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [0, 0, 0];
};
export const rgbToHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
