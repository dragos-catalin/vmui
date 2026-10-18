"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

export interface IntercomState {
  ringing: boolean;
  ringingSince: number | null;
  lastRingAt: number | null;
  lastOpenAt: number | null;
  autoOpenUntil: number | null;
  log: Array<{ at: number; event: string; by: string }>;
}

export const INTERCOM_KEY = ["intercom"] as const;

/** Electra intercom state, refreshed every 3 s while mounted. `url` lets the
 *  shared-token variant (`/api/esp/intercom?k=…`) reuse the same cache key. */
export function useIntercomState(initial: IntercomState, opts: { url?: string; interval?: number } = {}) {
  const url = opts.url ?? "/api/esp/intercom";
  return useQuery({
    queryKey: [...INTERCOM_KEY, url],
    queryFn: () => getJSON<IntercomState>(url),
    refetchInterval: opts.interval ?? 3000,
    initialData: initial,
    refetchOnWindowFocus: true,
  });
}

export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  status: string;
  approvedBy: string | null;
  lastSeenAt: string | Date | null;
  lastIp: string | null;
  createdAt: string | Date;
}
export type PendingDevice = PairedDevice & { code: string };
export interface PairedDevicesPayload {
  devices: PairedDevice[];
  pending: PendingDevice[];
  version: number;
}

export const PAIRED_DEVICES_KEY = ["paired-devices"] as const;

/** Long-polls `/api/devices?since=<version>`; the server holds the request
 *  until something changes, so a 1 s interval is effectively "reconnect
 *  right away". Paused while the tab is hidden. */
export function usePairedDevices() {
  const version = React.useRef<number | undefined>(undefined);
  const q = useQuery({
    queryKey: PAIRED_DEVICES_KEY,
    queryFn: async () => {
      const v = version.current;
      const j = await getJSON<PairedDevicesPayload>(`/api/devices${v === undefined ? "" : `?since=${v}`}`);
      version.current = j.version;
      return j;
    },
    refetchInterval: (query) => (query.state.status === "error" ? 5000 : 1000),
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
  });
  return { ...q, pending: q.data?.pending ?? [] };
}

export type EventSourceStatus = "connecting" | "open" | "error";

export interface EventSourceHandlers<T> {
  /** Named SSE `event:` types to listen for; default `["message"]`. */
  events?: string[];
  onMessage?: (data: T, event: string, raw: MessageEvent) => void;
  onOpen?: () => void;
  onError?: (attempt: number) => void;
  parse?: (raw: string) => T;
}

/** Owns an EventSource with exponential reconnect (1 s → 30 s). `url = null`
 *  disconnects. Handlers are read from a ref, so inline closures are fine. */
export function useEventSource<T = unknown>(url: string | null, handlers: EventSourceHandlers<T> = {}): { status: EventSourceStatus; attempt: number } {
  const [status, setStatus] = React.useState<EventSourceStatus>("connecting");
  const [attempt, setAttempt] = React.useState(0);
  const h = React.useRef(handlers);
  h.current = handlers;
  const eventNames = (handlers.events ?? ["message"]).join("\u0000");

  React.useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    let alive = true;

    const connect = () => {
      if (!alive) return;
      setStatus("connecting");
      es = new EventSource(url);
      const parse = h.current.parse ?? ((raw: string) => JSON.parse(raw) as T);
      const onEvent = (ev: Event) => {
        const me = ev as MessageEvent<string>;
        let data: T;
        try {
          data = parse(me.data);
        } catch {
          return;
        }
        h.current.onMessage?.(data, me.type, me);
      };
      for (const name of eventNames.split("\u0000")) es.addEventListener(name, onEvent);
      es.onopen = () => {
        tries = 0;
        setAttempt(0);
        setStatus("open");
        h.current.onOpen?.();
      };
      es.onerror = () => {
        es?.close();
        es = null;
        tries += 1;
        setAttempt(tries);
        setStatus("error");
        h.current.onError?.(tries);
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(tries - 1, 5));
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [url, eventNames]);

  return { status, attempt };
}

// ---------------------------------------------------------------------------
// Shared /api/events bus: ONE EventSource per tab, fanned out to every
// subscriber. Three components used to open their own, which together with the
// per-card stats streams exhausted the 6-connection HTTP/1.1 pool.
// ---------------------------------------------------------------------------
type BusListener = (data: unknown, raw: MessageEvent) => void;
const bus = {
  es: null as EventSource | null,
  listeners: new Map<string, Set<BusListener>>(),
  attached: new Set<string>(),
  refs: 0,
  timer: null as ReturnType<typeof setTimeout> | null,
  tries: 0,
};

function busAttach(name: string) {
  if (!bus.es || bus.attached.has(name)) return;
  bus.attached.add(name);
  bus.es.addEventListener(name, (ev) => {
    const me = ev as MessageEvent<string>;
    let data: unknown = me.data;
    try {
      data = JSON.parse(me.data);
    } catch {
      /* non-JSON payloads are passed through as strings */
    }
    for (const fn of bus.listeners.get(name) ?? []) fn(data, me);
  });
}

function busConnect() {
  if (typeof EventSource === "undefined" || bus.es) return;
  bus.es = new EventSource("/api/events");
  bus.attached.clear();
  for (const name of bus.listeners.keys()) busAttach(name);
  bus.es.onopen = () => {
    bus.tries = 0;
  };
  bus.es.onerror = () => {
    bus.es?.close();
    bus.es = null;
    if (bus.refs === 0) return;
    bus.tries += 1;
    bus.timer = setTimeout(busConnect, Math.min(30_000, 1000 * 2 ** Math.min(bus.tries - 1, 5)));
  };
}

/** Subscribe to named events on the shared `/api/events` stream. `handlers`
 *  maps event name -> callback (parsed JSON). Inline closures are fine. */
export function useEventsBus(handlers: Record<string, (data: unknown, raw: MessageEvent) => void>, enabled = true): void {
  const h = React.useRef(handlers);
  h.current = handlers;
  const names = Object.keys(handlers).sort().join("\u0000");
  React.useEffect(() => {
    if (!enabled || !names) return;
    const subs: Array<[string, BusListener]> = names.split("\u0000").map((n) => [n, (d, raw) => h.current[n]?.(d, raw)]);
    for (const [n, fn] of subs) {
      if (!bus.listeners.has(n)) bus.listeners.set(n, new Set());
      bus.listeners.get(n)!.add(fn);
    }
    bus.refs += 1;
    busConnect();
    for (const [n] of subs) busAttach(n);
    return () => {
      for (const [n, fn] of subs) bus.listeners.get(n)?.delete(fn);
      bus.refs -= 1;
      if (bus.refs === 0) {
        if (bus.timer) clearTimeout(bus.timer);
        bus.timer = null;
        bus.es?.close();
        bus.es = null;
      }
    };
  }, [names, enabled]);
}

/** `document.visibilityState === "visible"`, reactive. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** setInterval that pauses while the tab is hidden (and when `ms` is null).
 *  Use for clocks, mirrors and light polling; use TanStack Query for data. */
export function useInterval(fn: () => void, ms: number | null, opts: { pauseHidden?: boolean; immediate?: boolean } = {}): void {
  const { pauseHidden = true, immediate = false } = opts;
  const visible = usePageVisible();
  const cb = React.useRef(fn);
  cb.current = fn;
  const active = ms !== null && (!pauseHidden || visible);
  React.useEffect(() => {
    if (!active || ms === null) return;
    if (immediate) cb.current();
    const id = setInterval(() => cb.current(), ms);
    return () => clearInterval(id);
  }, [active, ms, immediate]);
}

/** True once the element has been on screen (IntersectionObserver), for
 *  deferring screenshots/streams of off-screen cards. */
export function useInView<T extends Element>(rootMargin = "200px"): [React.RefCallback<T>, boolean] {
  const [inView, setInView] = React.useState(false);
  const obs = React.useRef<IntersectionObserver | null>(null);
  const ref = React.useCallback(
    (el: T | null) => {
      obs.current?.disconnect();
      if (!el || typeof IntersectionObserver === "undefined") return;
      obs.current = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin });
      obs.current.observe(el);
    },
    [rootMargin],
  );
  return [ref, inView];
}
