"use client";

import { VatraMark } from "@/components/brand/vatra-mark";
import { useInterval } from "@/hooks/use-poll";
import type { DisplaySettings, DisplayViewId } from "@/lib/display/settings-meta";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { tapFx } from "./kiosk-fx";

/* ------------------------------------------------------------------ types */
type Ent = { state: string; attributes: Record<string, unknown> };
type Photo = { url: string; title?: string | null; credit?: string | null; source?: string };
type Media = { id: string; name: string | null; state: string; title: string | null; artist: string | null; app: string | null; art: string | null; position: number | null; duration: number | null; positionAt: string | null };
type Device = { id: string; name: string; kind: string; entity?: string; entities?: string[]; room: string; whiteOnly?: boolean; via: string };
type Room = { id: string; name: string };
type State = {
  now: number;
  haOnline?: boolean;
  haUrl: string | null;
  display: DisplaySettings & { tapFeedback?: boolean };
  rooms: Room[];
  devices: Device[];
  entities: Record<string, Ent>;
  photos?: Photo[];
  weather?: Ent | null;
  forecast?: Array<{ t: number; cond: string; hi: number; lo: number }>;
  hourly?: Array<{ t: number; temp: number; cond: string }>;
  inside?: { temp?: Ent | null; hum?: Ent | null } | null;
  home?: { door?: Ent; presence?: Ent; lightsOn?: number; lightsTotal?: number } | null;
  media?: Media[];
  calendar?: Array<{ title: string; start: number | string; allDay?: boolean }>;
  fx?: { date: string; rates: Array<{ code: string; rate: number; prev: number }> } | null;
  crypto?: Array<{ symbol: string; price: number; change24h: number }> | null;
  nutrition?: { targets: { calories: number; protein: number; carbs: number; fats: number }; today: { calories: number; protein: number; carbs: number; fats: number; meals: number }; water: { ml: number; glasses: number; targetMl: number; underPace: boolean } } | null;
  pcs?: Record<string, Record<string, unknown>>;
  pi?: Record<string, unknown> | null;
  batteries?: Array<{ name: string; pct: number }>;
  ambilight?: { hyper?: Ent } | null;
  hubIdle?: boolean;
  build?: string;
};
type Api = (p: string, i?: RequestInit) => Promise<Response>;

const COND: Record<string, string> = { sunny: "☀", "clear-night": "☾", partlycloudy: "⛅", cloudy: "☁", rainy: "🌧", pouring: "🌧", snowy: "🌨", fog: "🌫", lightning: "⛈", "lightning-rainy": "⛈", windy: "💨" };
// HA condition → message key (several HA states share one word)
const COND_KEY = { sunny: "sunny", "clear-night": "clearNight", partlycloudy: "partlyCloudy", cloudy: "cloudy", rainy: "rainy", pouring: "pouring", snowy: "snowy", fog: "fog", lightning: "storm", "lightning-rainy": "storm", windy: "windy" } as const;
const HVAC = ["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"] as const;
const MEDIA_CMDS = [
  ["previous_track", "⏮"],
  ["play_pause", "⏯"],
  ["next_track", "⏭"],
  ["volume_down", "🔉"],
  ["volume_up", "🔊"],
  ["volume_mute", "🔇"],
  ["turn_off", "⏻"],
] as const;
const SWATCHES = [
  ["warm", [255, 180, 90]],
  ["orange", [255, 120, 60]],
  ["red", [255, 60, 80]],
  ["purple", [200, 80, 255]],
  ["blue", [80, 140, 255]],
  ["teal", [60, 220, 200]],
  ["green", [120, 255, 120]],
  ["white", [255, 255, 255]],
] as const;
const KIOSK_ROOMS = ["bedroom", "living_room", "kitchen", "office"] as const;

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pct = (v: unknown) => Math.max(0, Math.min(1, num(v) / 100));

function inNight(s: DisplaySettings, now: Date): boolean {
  const [fh, fm] = s.nightFrom.split(":").map(Number);
  const [th, tm] = s.nightTo.split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = (fh ?? 23) * 60 + (fm ?? 0);
  const to = (th ?? 7) * 60 + (tm ?? 0);
  return from > to ? cur >= from || cur < to : cur >= from && cur < to;
}

/* Query flags are read once per load (HM-20); kiosk debugging toggles them by reloading. */
const ParamsContext = React.createContext<URLSearchParams>(new URLSearchParams());
const useParams = () => React.useContext(ParamsContext);
/** Tap feedback (MO-09): `?fx=1` or `display.tapFeedback`. */
const FxContext = React.createContext<() => void>(() => undefined);
const useTapFx = () => React.useContext(FxContext);

/** Locale-aware time/date/weather words for the kiosk (HM-01). */
function useKioskText() {
  const t = useTranslations("nestHub.kiosk");
  const fmt = useFormatter();
  const rooms = useTranslations("home.rooms");
  return React.useMemo(
    () => ({
      hhmm: (ms: number) => fmt.dateTime(new Date(ms), { hour: "2-digit", minute: "2-digit" }),
      dateLong: (d: Date) => fmt.dateTime(d, { weekday: "long", day: "numeric", month: "long" }),
      dayShort: (d: Date) => fmt.dateTime(d, { weekday: "short" }),
      dayDate: (d: Date) => fmt.dateTime(d, { weekday: "short", day: "numeric" }),
      cond: (s?: string) => (s && s in COND_KEY ? t(`cond.${COND_KEY[s as keyof typeof COND_KEY]}`) : (s ?? "")),
      room: (r: Room) => ((KIOSK_ROOMS as readonly string[]).includes(r.id) ? rooms(r.id as (typeof KIOSK_ROOMS)[number]) : r.name),
      hvac: (s?: string) => (s && (HVAC as readonly string[]).includes(s) ? t(`hvac.${s as (typeof HVAC)[number]}`) : (s ?? "—")),
      uptime: (s: number) => (s >= 86400 ? t("upDays", { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) }) : t("upHours", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })),
      number: (n: number, digits = 0) => fmt.number(n, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    }),
    [t, fmt, rooms],
  );
}

/* ------------------------------------------------------------------ root */
export function Kiosk({ token, deviceToken = "" }: { token: string; deviceToken?: string }) {
  const t = useTranslations("nestHub.kiosk");
  const params = React.useMemo(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)), []);
  const [st, setSt] = React.useState<State | null>(null);
  const [online, setOnline] = React.useState(true);
  const [mode, setMode] = React.useState<"idle" | "home">("idle");
  const [tick, setTick] = React.useState(() => Date.now());
  const [wait, setWait] = React.useState(3000);
  const lastTouch = React.useRef(Date.now());
  const idleFlag = React.useRef<boolean | null>(null);
  const buildRef = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);
  const holdHome = params.has("home"); // debug: hold the home screen for a perf sample

  React.useEffect(() => {
    if (holdHome) setMode("home");
  }, [holdHome]);
  useInterval(() => (lastTouch.current = Date.now()), holdHome ? 500 : null);

  const api = React.useCallback<Api>(
    (path, init) => fetch(`/api/display/${path}?${token ? `k=${encodeURIComponent(token)}` : `d=${encodeURIComponent(deviceToken)}`}`, { cache: "no-store", ...init }),
    [token, deviceToken],
  );

  // ?perf=1 — 60 s of rAF fps + long tasks + memory, posted once to /api/display/probe (audit_log)
  React.useEffect(() => {
    if (!params.has("perf")) return;
    const frames: number[] = [];
    let last = performance.now();
    let raf = 0;
    const tickFrame = (ts: number) => {
      frames.push(ts - last);
      last = ts;
      raf = requestAnimationFrame(tickFrame);
    };
    raf = requestAnimationFrame(tickFrame);
    const long: number[] = [];
    const longAt: number[] = [];
    const t0 = performance.now();
    let po: PerformanceObserver | undefined;
    try {
      po = new PerformanceObserver((l) => l.getEntries().forEach((e) => { long.push(Math.round(e.duration)); longAt.push(Math.round((e.startTime - t0) / 1000)); }));
      po.observe({ type: "longtask", buffered: true });
    } catch { /* not supported */ }
    const done = setTimeout(() => {
      cancelAnimationFrame(raf);
      po?.disconnect();
      const sorted = [...frames].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
      // frames per second, one bucket per second — shows whether 44 fps is a steady rate or 60 with holes
      const perSec: number[] = [];
      let acc = 0, sec = 0;
      for (const f of frames) { acc += f; if (acc >= 1000) { perSec.push(sec + 1); acc -= 1000; sec = 0; } else sec++; }
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      void api("probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ perf: true, hub: navigator.userAgent.includes("CrKey"), q: location.search, mode: document.querySelector(".dk")?.className ?? "", secs: 60, frames: frames.length, fps: Math.round(1000 / avg), p50ms: Math.round(p(0.5)), p95ms: Math.round(p(0.95)), maxMs: Math.round(sorted.at(-1) ?? 0), dropped: frames.filter((f) => f > 34).length, longTasks: long, longAt, perSec, heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null }),
      });
    }, 60000);
    return () => {
      cancelAnimationFrame(raf);
      po?.disconnect();
      clearTimeout(done);
    };
  }, [api, params]);

  // poll: 3 s, 10 s in the night window, 2 s while music plays (position bar), 5 s after a failure
  const poll = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await api("state");
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as State;
      // new server build -> pick up the new page (DashCast never reloads on its own)
      if (j.build && buildRef.current && j.build !== buildRef.current) location.reload();
      buildRef.current = j.build ?? buildRef.current;
      setSt(j);
      setOnline(true);
      const playing = (j.media ?? []).some((x) => x.state === "playing");
      setWait(playing ? 2000 : inNight(j.display, new Date()) ? 10000 : 3000);
      // the Hub's own touch is only visible to us through HA (input_boolean.nest_hub_idle)
      if (j.hubIdle === false && idleFlag.current !== false) {
        lastTouch.current = Date.now();
        setMode("home");
      }
      idleFlag.current = j.hubIdle ?? null;
    } catch {
      setOnline(false);
      setWait(5000);
    } finally {
      inFlight.current = false;
    }
  }, [api]);
  React.useEffect(() => void poll(), [poll]);
  useInterval(() => void poll(), wait, { pauseHidden: false });

  // 1 s clock, also drives the idle timeout
  useInterval(
    () => {
      const now = Date.now();
      setTick(now);
      if (mode === "home" && st && now - lastTouch.current > st.display.idleAfterSec * 1000) {
        setMode("idle");
        void api("control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "idle", on: true }) }).catch(() => undefined);
      }
    },
    1000,
    { pauseHidden: false },
  );

  const wake = React.useCallback(() => {
    lastTouch.current = Date.now();
    if (mode !== "home") {
      const go = () => setMode("home");
      const d = document as Document & { startViewTransition?: (cb: () => void) => void };
      if (d.startViewTransition) d.startViewTransition(go);
      else go();
      void api("control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "idle", on: false }) }).catch(() => undefined);
    }
  }, [mode, api]);

  const fxOn = params.get("fx") === "1" || st?.display.tapFeedback === true;
  const fx = React.useCallback(() => {
    if (fxOn) tapFx();
  }, [fxOn]);

  const s = st?.display;
  const night = s ? inNight(s, new Date(tick)) : false;
  // the accent is device data (#rrggbb from the settings); the fallback is the lit token
  const style = { "--accent": s?.accent ?? "var(--color-lit)", "--dim": String(s?.dim ?? 0.35), "--night": String(night ? (s?.nightDim ?? 0.35) : 1) } as React.CSSProperties;

  if (!st) {
    return (
      <div className="dk" style={style}>
        <div className="dk-flat" />
        <div className="dk-loading" role="status" aria-live="polite">
          <VatraMark size={64} state={online ? "thinking" : "error"} label={online ? t("loading") : t("offline")} />
          <span className="muted">{online ? t("loading") : t("offline")}</span>
        </div>
      </div>
    );
  }

  return (
    <ParamsContext.Provider value={params}>
      <FxContext.Provider value={fx}>
        <div className={`dk ${mode}`} style={style} onPointerDown={wake}>
          <Idle st={st} tick={tick} active={mode === "idle"} />
          {mode === "home" && <Home st={st} tick={tick} api={api} onTouch={() => (lastTouch.current = Date.now())} />}
          <div className="dk-night" />
          {!online && (
            <div className="chip off" role="status">
              <i />
              {t("offline")}
            </div>
          )}
        </div>
      </FxContext.Provider>
    </ParamsContext.Provider>
  );
}

/* ------------------------------------------------------------------ idle rotation */
function Idle({ st, tick, active }: { st: State; tick: number; active: boolean }) {
  const dbg = useParams();
  const views = React.useMemo(() => {
    const enabled = st.display.views.filter((v) => v.enabled);
    const playing = (st.media ?? []).some((m) => m.state === "playing");
    return enabled.filter((v) => {
      if (v.id === "media") return playing;
      if (v.id === "pc") return Object.keys(st.pcs ?? {}).length > 0;
      if (v.id === "pi") return !!st.pi;
      if (v.id === "photo") return (st.photos?.length ?? 0) > 0;
      if (v.id === "calendar") return (st.calendar?.length ?? 0) > 0;
      if (v.id === "fx") return !!st.fx;
      if (v.id === "crypto") return (st.crypto?.length ?? 0) > 0;
      if (v.id === "nutrition") return !!st.nutrition;
      return true;
    });
  }, [st]);

  const [idx, setIdx] = React.useState(0);
  const [prev, setPrev] = React.useState<DisplayViewId | null>(null);
  const since = React.useRef(Date.now());
  const cur = views[idx % Math.max(1, views.length)] ?? views[0];

  React.useEffect(() => {
    if (!active || !cur) return;
    if (tick - since.current >= cur.dwellSec * 1000 && views.length > 1) {
      setPrev(cur.id);
      setIdx((i) => (i + 1) % views.length);
      since.current = tick;
      const tm = setTimeout(() => setPrev(null), 400);
      return () => clearTimeout(tm);
    }
  }, [tick, active, cur, views.length]);

  const wantPhoto = cur ? cur.photo || cur.id === "photo" : true;
  const photos = st.photos ?? [];
  // the photo actually on screen, reported by PhotoLayer once it has decoded — the caption follows it
  const [shown, setShown] = React.useState<Photo | undefined>(undefined);
  const media = (st.media ?? []).find((m) => m.state === "playing") ?? st.media?.[0] ?? null;
  const art = media?.art ? (media.art.startsWith("/") ? `${st.haUrl ?? ""}${media.art}` : media.art) : null;
  // perf bisect flags: ?bare=1 photo only (no veil, no view); ?noveil=1; ?notext=1 (view without shadows)
  const bare = dbg.has("bare");

  return (
    <>
      {cur?.id === "media" && art ? <div className={`media-bg on`} style={{ backgroundImage: `url("${art}")` }} /> : <PhotoLayer photos={dbg.has("nophoto") ? [] : photos} sec={st.display.photoSec} on={wantPhoto && cur?.id !== "media"} onShow={setShown} />}
      {!wantPhoto && !bare && <div className="dk-flat" />}
      {!bare && !dbg.has("noveil") && <div className="dk-veil" />}
      {active && !bare && prev && prev !== cur?.id && <div className="dk-view out" key={`out-${prev}`} />}
      {active && !bare && cur && (
        <div className={`dk-view ${cur.id} ${dbg.has("notext") ? "notext" : ""}`} key={cur.id}>
          <View id={cur.id} st={st} tick={tick} media={media} art={art} photo={wantPhoto ? shown : undefined} />
        </div>
      )}
      {active && !bare && cur && cur.id !== "clock" && cur.id !== "weather" && <Strip st={st} tick={tick} />}
      {active && !bare && cur && cur.id !== "media" && media && <NowPlaying media={media} art={art} tick={tick} />}
    </>
  );
}

/* two <img>s crossfade; Ken Burns runs on the visible one */
function PhotoLayer({ photos, sec, on, onShow }: { photos: Photo[]; sec: number; on: boolean; onShow: (p: Photo | undefined) => void }) {
  const dbg = useParams();
  const [i, setI] = React.useState(0);
  const [slot, setSlot] = React.useState(0);
  const urls = React.useRef<[string | null, string | null]>([null, null]);
  const reduced = React.useMemo(() => (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) || dbg.has("nokb"), [dbg]);
  const staticCls = dbg.has("static") ? "static" : "";

  // Random order that alternates sources (a Met run of eight would otherwise
  // look like one museum), reshuffled only when the pool itself changes.
  const order = React.useMemo(() => {
    const groups = new Map<string, Photo[]>();
    for (const p of photos) groups.set(p.source ?? "", [...(groups.get(p.source ?? "") ?? []), p]);
    for (const g of groups.values()) g.sort(() => Math.random() - 0.5);
    const out: Photo[] = [];
    const lists = [...groups.values()].sort(() => Math.random() - 0.5);
    while (lists.some((l) => l.length)) for (const l of lists) if (l.length) out.push(l.pop()!);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on pool identity, not on element order
  }, [photos.map((p) => p.url).join("|")]);

  useInterval(() => setI((x) => (x + 1) % Math.max(1, order.length)), order.length ? sec * 1000 : null, { pauseHidden: false });

  const cur = order[i % Math.max(1, order.length)];
  const url = cur?.url ?? null;
  React.useEffect(() => {
    if (!url || !cur) return;
    let alive = true;
    const img = new Image();
    img.src = url;
    // decode() keeps the JPEG decode off the frame that swaps the slot
    img.decode().then(() => {
      if (!alive) return;
      setSlot((sl) => {
        const nx = (sl + 1) % 2;
        urls.current[nx] = url;
        return nx;
      });
      onShow(cur);
    }).catch(() => {
      // broken URL: skip it instead of showing the previous photo under a wrong caption
      if (alive) setI((x) => (x + 1) % Math.max(1, order.length));
    });
    return () => {
      alive = false;
    };
  }, [url, cur, order.length, onShow]);

  return (
    <>
      {[0, 1].map((k) => {
        const u = urls.current[k];
        const vis = on && slot === k && !!u;
        const seed = (u ?? "").length;
        return (
          // Measured on the Hub (docs/home-assistant.md): a 108 %-oversized layer with
          // will-change ran at 44 fps; a 100 % <img> scaled from a corner origin runs at 60.
          // eslint-disable-next-line @next/next/no-img-element -- external photo CDN, no optimisation wanted
          <img
            key={`${k}-${u ?? ""}`}
            alt=""
            src={u ?? undefined}
            decoding="async"
            className={`dk-photo ${vis ? "on" : ""} ${vis && !reduced ? "kb" : ""} ${staticCls}`}
            style={u ? ({ "--kb": `${sec + 4}s`, "--kbo": `${seed % 2 ? 35 : 65}% ${seed % 3 ? 40 : 60}%` } as React.CSSProperties) : undefined}
          />
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ views */
function View({ id, st, tick, media, art, photo }: { id: DisplayViewId; st: State; tick: number; media: Media | null; art: string | null; photo?: Photo }) {
  const t = useTranslations("nestHub.kiosk");
  const k = useKioskText();
  const d = new Date(tick);
  switch (id) {
    case "clock": {
      const w = st.weather;
      const temp = num(w?.attributes.temperature, NaN);
      const inside = Number(st.inside?.temp?.state);
      const next = (st.calendar ?? [])[0];
      return (
        <div className="clock" style={{ display: "contents" }}>
          <div style={{ alignSelf: "end" }}>
            <div className="time">{k.hhmm(tick)}</div>
            <div className="date">{k.dateLong(d)}{next ? ` · ${typeof next.start === "number" ? k.hhmm(next.start) : ""} ${next.title}` : ""}</div>
          </div>
          <div className="side">
            {Number.isFinite(temp) && (
              <>
                <div className="t">{Math.round(temp)}°</div>
                <div className="s">
                  <span aria-hidden>{COND[w?.state ?? ""] ?? ""}</span> {k.cond(w?.state)}
                  {Number.isFinite(inside) ? ` · ${t("insideBedroom", { t: k.number(inside, 1) })}` : ""}
                </div>
              </>
            )}
          </div>
          {photo && <Caption p={photo} />}
          <span className="dk-mark" aria-hidden>
            <VatraMark size={20} state="idle" />
          </span>
        </div>
      );
    }
    case "weather": {
      const w = st.weather;
      const hours = (st.hourly ?? []).filter((h) => h.t > tick - 1800e3).slice(0, 8);
      const days = (st.forecast ?? []).slice(0, 5);
      return (
        <div style={{ display: "grid", gridTemplateRows: "1fr auto", gap: 18, alignContent: "end" }}>
          <div className="row" style={{ alignItems: "center", gap: 28 }}>
            <div className="num" style={{ fontSize: 150 }}>{Math.round(num(w?.attributes.temperature))}°</div>
            <div>
              <div style={{ fontSize: 34, fontWeight: 600 }}>{k.cond(w?.state)}</div>
              <div className="muted" style={{ fontSize: 22, marginTop: 6 }}>
                {t("weatherLine", { h: num(w?.attributes.humidity), w: Math.round(num(w?.attributes.wind_speed)), p: num(w?.attributes.pressure) })}
              </div>
            </div>
          </div>
          <div className="plate" style={{ display: "grid", gridTemplateColumns: `repeat(${hours.length + days.length}, 1fr)`, gap: 6, padding: "18px 22px" }}>
            {hours.map((h) => (
              <div key={h.t} style={{ textAlign: "center" }}>
                <div className="muted" style={{ fontSize: 15 }}>{k.hhmm(h.t)}</div>
                <div style={{ fontSize: 26, margin: "4px 0" }} title={k.cond(h.cond)}>{COND[h.cond] ?? "·"}</div>
                <div style={{ fontSize: 22 }}>{Math.round(h.temp)}°</div>
              </div>
            ))}
            {days.map((f) => (
              <div key={f.t} style={{ textAlign: "center", borderLeft: "1px solid var(--hair)" }}>
                <div className="muted" style={{ fontSize: 15 }}>{k.dayShort(new Date(f.t))}</div>
                <div style={{ fontSize: 26, margin: "4px 0" }} title={k.cond(f.cond)}>{COND[f.cond] ?? "·"}</div>
                <div style={{ fontSize: 20 }}>{Math.round(f.hi)}° <span className="muted">{Math.round(f.lo)}°</span></div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "home": {
      const h = st.home;
      const inside = Number(st.inside?.temp?.state);
      const hum = Number(st.inside?.hum?.state);
      const acs = st.devices.filter((x) => x.kind === "ac" && x.entity).map((x) => ({ d: x, e: st.entities[x.entity!] })).filter((x) => x.e);
      const low = (st.batteries ?? []).filter((b) => b.pct < 25);
      const presence = h?.presence?.state === "on" ? t("someoneHome") : h?.presence?.state === "unavailable" ? t("presenceOffline") : t("nobodyBedroom");
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ maxWidth: 560, display: "grid", gap: 16 }}>
            <h2>{t("homeTitle")}</h2>
            <div className="row" style={{ gap: 36 }}>
              <div><div className="num" style={{ fontSize: 72 }}>{Number.isFinite(inside) ? k.number(inside, 1) : "—"}°</div><div className="muted">{t("bedroom")}{Number.isFinite(hum) ? ` · ${Math.round(hum)} %` : ""}</div></div>
              <div><div className="num" style={{ fontSize: 72 }}>{h?.lightsOn ?? 0}<span className="muted" style={{ fontSize: 30 }}>/{h?.lightsTotal ?? "–"}</span></div><div className="muted">{t("lightsOn")}</div></div>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 19 }}>
              <span className={h?.door?.state === "on" ? "accent" : "muted"}>{h?.door?.state === "on" ? t("doorOpen") : t("doorClosed")}</span>
              <span className="muted" aria-hidden>·</span>
              <span className={h?.presence?.state === "on" ? "accent" : "muted"}>{presence}</span>
              {acs.map(({ d: dev, e }) =>
                e ? (
                  <React.Fragment key={dev.id}><span className="muted" aria-hidden>·</span><span className={e.state !== "off" ? "cool" : "muted"}>{dev.name} {e.state === "off" ? k.hvac("off") : `${k.hvac(e.state)} ${num(e.attributes.temperature)}°`}</span></React.Fragment>
                ) : null,
              )}
              {low.length > 0 && <><span className="muted" aria-hidden>·</span><span className="accent">{t("battery", { list: low.map((b) => `${b.name} ${b.pct}%`).join(", ") })}</span></>}
            </div>
          </div>
          {photo && <Caption p={photo} />}
        </div>
      );
    }
    case "media": {
      if (!media) return null;
      const pos = media.position != null && media.positionAt ? media.position + (media.state === "playing" ? (tick - new Date(media.positionAt).getTime()) / 1000 : 0) : null;
      const dur = media.duration ?? 0;
      return (
        <div className="media" style={{ display: "grid" }}>
          <div className="art" style={art ? { backgroundImage: `url("${art}")` } : { background: "oklch(1 0 0 / 0.1)" }} />
          <div>
            <div className="muted" style={{ fontSize: 17, letterSpacing: ".12em", textTransform: "uppercase" }}>{media.app ?? ""} · {media.name}</div>
            <div className="title">{media.title ?? "—"}</div>
            <div className="artist">{media.artist ?? ""}</div>
            {dur > 0 && pos != null && (
              <div className="prog">
                <div className="bar"><i style={{ "--v": String(Math.min(1, pos / dur)) } as React.CSSProperties} /></div>
                <div className="row muted" style={{ justifyContent: "space-between", fontSize: 17, marginTop: 8 }}><span>{mmss(pos)}</span><span>{mmss(dur)}</span></div>
              </div>
            )}
          </div>
        </div>
      );
    }
    case "photo":
      return <div style={{ alignContent: "end" }}>{photo && <Caption p={photo} />}</div>;
    case "nutrition": {
      const n = st.nutrition;
      if (!n) return null;
      const w = n.water;
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ display: "grid", gridTemplateColumns: "auto auto 1fr", gap: 36, alignItems: "center", maxWidth: 820 }}>
            <Arc v={n.today.calories / Math.max(1, n.targets.calories)} big={String(n.today.calories)} small={t("kcal")} />
            <Arc v={w.ml / Math.max(1, w.targetMl)} big={String(w.glasses)} small={t("glasses", { n: w.glasses })} cool />
            <div style={{ display: "grid", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{t("nutritionTitle")}</h2>
              {(["protein", "carbs", "fats"] as const).map((key) => (
                <div key={key}>
                  <div className="row muted" style={{ justifyContent: "space-between", fontSize: 17 }}><span>{t(`macro.${key}`)}</span><span>{Math.round(n.today[key])} / {n.targets[key]} g</span></div>
                  <div className="bar" style={{ marginTop: 6 }}><i style={{ "--v": String(Math.min(1, n.today[key] / Math.max(1, n.targets[key]))) } as React.CSSProperties} /></div>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 17 }}>
                {t("waterLine", { ml: w.ml, target: w.targetMl })}
                {w.underPace ? ` · ${t("underPace")}` : ""} · {t("meals", { n: n.today.meals })}
              </div>
            </div>
          </div>
        </div>
      );
    }
    case "pc": {
      const hosts = Object.entries(st.pcs ?? {});
      return (
        <div style={{ alignContent: "end", display: "grid", gap: 14 }}>
          {hosts.slice(0, 2).map(([host, mm]) => {
            const disks = (mm.disks as Array<{ drive: string; pct: number; freeGb: number }> | undefined) ?? [];
            const focus = mm.focus as { proc?: string; title?: string } | undefined;
            return (
              <div className="plate" key={host} style={{ display: "grid", gridTemplateColumns: "auto auto auto 1fr", gap: 28, alignItems: "center" }}>
                <Arc v={pct(mm.cpu)} big={`${Math.round(num(mm.cpu))}`} small={t("cpuPct")} />
                <Arc v={pct(mm.gpu)} big={`${Math.round(num(mm.gpu))}`} small={t("gpuTemp", { t: Math.round(num(mm.gpuTemp)) })} />
                <Arc v={pct(mm.ram)} big={`${Math.round(num(mm.ram))}`} small={t("ramPct")} cool />
                <div>
                  <h2>{host}</h2>
                  {focus?.title && <div style={{ fontSize: 24, fontWeight: 600, textWrap: "balance" as never }}>{focus.title}</div>}
                  <div className="muted" style={{ fontSize: 17, marginTop: 8 }}>
                    {focus?.proc ? `${focus.proc} · ` : ""}
                    {t("up", { t: k.uptime(num(mm.uptime)) })}
                    {disks.length ? ` · ${disks.map((x) => t("diskFree", { drive: x.drive, gb: Math.round(x.freeGb) })).join(" · ")}` : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    case "pi": {
      const p = st.pi;
      if (!p) return null;
      const thr = (p.throttled as { undervolt?: boolean; capped?: boolean; throttled?: boolean; softTemp?: boolean } | undefined) ?? {};
      const disk = p.disk as { pct?: number; freeGb?: number } | undefined;
      const flags = [thr.undervolt && t("undervolt"), thr.capped && t("capped"), thr.throttled && t("throttled"), thr.softTemp && t("softTemp")].filter(Boolean);
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ display: "grid", gridTemplateColumns: "auto auto auto 1fr", gap: 28, alignItems: "center", maxWidth: 900 }}>
            <Arc v={pct(p.cpu)} big={`${Math.round(num(p.cpu))}`} small={t("cpuMhz", { mhz: num(p.mhz) })} />
            <Arc v={Math.min(1, num(p.temp) / 85)} big={`${Math.round(num(p.temp))}°`} small="soc" />
            <Arc v={pct(p.ram)} big={`${Math.round(num(p.ram))}`} small={t("ramPct")} cool />
            <div>
              <h2>Raspberry Pi</h2>
              <div className="row" style={{ gap: 18 }}>
                <span style={{ fontSize: 34, fontWeight: 200 }} className={thr.undervolt ? "accent" : ""}>{k.number(num(p.coreV), 2)} V</span>
                <span className="muted" style={{ fontSize: 18 }}>{t("core")}{num(p.dips) ? ` · ${t("dips", { n: num(p.dips) })}` : ""}</span>
              </div>
              <div className="muted" style={{ fontSize: 17, marginTop: 8 }}>
                {t("load", { v: k.number(num(p.load), 2) })} · {t("containers", { n: num(p.containers) })} · {t("up", { t: k.uptime(num(p.uptime)) })}
                {disk ? ` · ${t("piDiskFree", { gb: Math.round(num(disk.freeGb)) })}` : ""} · ↓{Math.round(num(p.rxKbps))} ↑{Math.round(num(p.txKbps))} kb/s
              </div>
              {flags.length > 0 && <div className="accent" style={{ fontSize: 17, marginTop: 6 }}>{flags.join(" · ")}</div>}
            </div>
          </div>
        </div>
      );
    }
    case "calendar": {
      const ev = (st.calendar ?? []).slice(0, 5);
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ maxWidth: 620, display: "grid", gap: 10 }}>
            <h2>{t("upcoming")}</h2>
            {ev.map((e, i) => {
              const ts = typeof e.start === "number" ? e.start : Date.parse(e.start);
              return (
                <div className="row" key={i} style={{ gap: 18, fontSize: 24 }}>
                  <span className="muted" style={{ minWidth: 150, fontSize: 19 }}>{k.dayDate(new Date(ts))} {e.allDay ? "" : k.hhmm(ts)}</span>
                  <span style={{ fontWeight: 600 }}>{e.title}</span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    case "fx": {
      const fx = st.fx;
      if (!fx) return null;
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ display: "grid", gridTemplateColumns: `repeat(${fx.rates.length}, 1fr)`, gap: 30, maxWidth: 760 }}>
            {fx.rates.map((r) => {
              const dlt = r.rate - r.prev;
              return (
                <div key={r.code}>
                  <h2>{r.code}</h2>
                  <div className="num" style={{ fontSize: 64 }}>{k.number(r.rate, 4)}</div>
                  <div className={dlt >= 0 ? "accent" : "cool"} style={{ fontSize: 19, marginTop: 6 }}>
                    <span role="img" aria-label={dlt >= 0 ? t("rising") : t("falling")}>{dlt >= 0 ? "▲" : "▼"}</span> {k.number(Math.abs(dlt), 4)} <span className="muted">{t("fxSource", { date: fx.date })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    case "crypto": {
      const c = (st.crypto ?? []).slice(0, 3);
      return (
        <div style={{ alignContent: "end" }}>
          <div className="plate" style={{ display: "grid", gridTemplateColumns: `repeat(${c.length}, 1fr)`, gap: 30, maxWidth: 760 }}>
            {c.map((x) => (
              <div key={x.symbol}>
                <h2>{x.symbol}</h2>
                <div className="num" style={{ fontSize: 60 }}>${k.number(Math.round(x.price))}</div>
                <div className={x.change24h >= 0 ? "accent" : "cool"} style={{ fontSize: 19, marginTop: 6 }}><span role="img" aria-label={x.change24h >= 0 ? t("rising") : t("falling")}>{x.change24h >= 0 ? "▲" : "▼"}</span> {k.number(Math.abs(x.change24h), 2)} % <span className="muted">24 h</span></div>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }
  return null;
}

function Caption({ p }: { p: Photo }) {
  if (!p.title && !p.credit) return null;
  return <div className="caption">{p.title}{p.credit ? <span className="muted"> · {p.credit}</span> : null}</div>;
}
/* Whatever plays in the bedroom, as a card in the corner of every other panel.
   The rotation is not interrupted; the media view itself shows the full-screen version. */
function NowPlaying({ media, art, tick }: { media: Media; art: string | null; tick: number }) {
  const pos = media.position != null && media.positionAt ? media.position + (media.state === "playing" ? (tick - new Date(media.positionAt).getTime()) / 1000 : 0) : null;
  const dur = media.duration ?? 0;
  return (
    <div className="np">
      {/* eslint-disable-next-line @next/next/no-img-element -- HA entity_picture, no optimisation wanted */}
      {art ? <img className="art" src={art} alt="" decoding="async" /> : <div className="art" />}
      <div style={{ minWidth: 0 }}>
        <div className="t">
          {media.state === "playing" && <span className="eq" aria-hidden><i /><i /><i /></span>}
          {media.title ?? media.app ?? "—"}
        </div>
        <div className="a">{[media.artist, media.name].filter(Boolean).join(" · ")}</div>
        {dur > 0 && pos != null && <div className="bar"><i style={{ "--v": String(Math.min(1, pos / dur)) } as React.CSSProperties} /></div>}
      </div>
    </div>
  );
}
/* Clock + outside weather, top-right, on every panel that does not already
   carry them (clock, weather). Same figures as the clock view, smaller. */
function Strip({ st, tick }: { st: State; tick: number }) {
  const k = useKioskText();
  const w = st.weather;
  const temp = num(w?.attributes.temperature, NaN);
  return (
    <div className="strip">
      <div className="strip-time">{k.hhmm(tick)}</div>
      {Number.isFinite(temp) && (
        <div className="strip-w">
          <span className="strip-t">{Math.round(temp)}°</span>
          <span className="muted"><span aria-hidden>{COND[w?.state ?? ""] ?? ""}</span> {k.cond(w?.state)}</span>
        </div>
      )}
    </div>
  );
}
function Arc({ v, big, small, cool }: { v: number; big: string; small: string; cool?: boolean }) {
  return (
    <div className="arc" style={cool ? ({ "--accent": "var(--cool)" } as React.CSSProperties) : undefined}>
      <svg viewBox="0 0 140 140" aria-hidden><circle className="tr" cx="70" cy="70" r="54" /><circle className="va" cx="70" cy="70" r="54" style={{ "--v": String(Math.max(0, Math.min(1, v))) } as React.CSSProperties} /></svg>
      <div className="lab"><b>{big}</b><span>{small}</span></div>
    </div>
  );
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ------------------------------------------------------------------ home screen */
type Cmd = Record<string, unknown>;
type Send = (c: Cmd, o?: { entity: string; patch: Partial<Ent> }) => Promise<void>;
function Home({ st, tick, api, onTouch }: { st: State; tick: number; api: Api; onTouch: () => void }) {
  const t = useTranslations("nestHub.kiosk");
  const k = useKioskText();
  const rooms = st.rooms.filter((r) => st.devices.some((d) => d.room === r.id && d.entity));
  const [room, setRoom] = React.useState(rooms[0]?.id ?? "bedroom");
  const [sheet, setSheet] = React.useState<Device | "ambilight" | "water" | null>(null);
  const [pending, setPending] = React.useState<Record<string, Ent>>({});
  const send = React.useCallback<Send>(
    async (c, optimistic) => {
      onTouch();
      if (optimistic) setPending((p) => ({ ...p, [optimistic.entity]: { ...(st.entities[optimistic.entity] ?? { state: "", attributes: {} }), ...optimistic.patch } }));
      try {
        await api("control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
      } finally {
        setTimeout(() => setPending((p) => { const n = { ...p }; if (optimistic) delete n[optimistic.entity]; return n; }), 2500);
      }
    },
    [api, onTouch, st.entities],
  );
  const ent = (id?: string): Ent | undefined => (id ? pending[id] ?? st.entities[id] : undefined);
  const devs = st.devices.filter((d) => d.room === room && d.entity && !["proxy", "monitor", "pc"].includes(d.kind));
  const hyper = ent("light.hyperhdr");
  const water = st.nutrition?.water;

  const openSheet = (s: Device | "ambilight" | "water") => {
    onTouch();
    const d = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (d.startViewTransition) d.startViewTransition(() => setSheet(s));
    else setSheet(s);
  };
  const ambilightName = hyper?.state === "on" ? (String(hyper.attributes.effect ?? "").startsWith("Music") ? t("mode.music") : t("mode.movie")) : t("off");

  return (
    <div className="home-ui" onPointerDown={onTouch}>
      <div className="tabs" role="tablist" aria-label={t("roomsLabel")}>
        {rooms.map((r) => (
          <button key={r.id} role="tab" aria-selected={room === r.id} className={`tab ${room === r.id ? "on" : ""}`} onClick={() => setRoom(r.id)}>{k.room(r)}</button>
        ))}
        <button role="tab" aria-selected={room === "scene"} className={`tab ${room === "scene" ? "on" : ""}`} onClick={() => setRoom("scene")}>{t("scenes")}</button>
        <span className="sp" />
        <span className="clk">{k.hhmm(tick)}</span>
      </div>
      <div className="grid" role="tabpanel">
        {room === "scene" ? (
          <>
            <Tile i={0} on={!!hyper && hyper.state === "on"} k="ambilight" n={ambilightName} onTap={() => openSheet("ambilight")} onLong={() => openSheet("ambilight")} />
            <Tile i={1} cool on={false} k={t("waterKey")} n={water ? t("waterTile", { g: water.glasses, ml: water.ml }) : "—"} v={water ? <>{Math.round((water.ml / Math.max(1, water.targetMl)) * 100)}<small>%</small></> : undefined} onTap={() => void send({ type: "water", ml: 250 })} onLong={() => openSheet("water")} />
            <Tile i={2} on={false} k="pc" n={t("wakePc")} onTap={() => void send({ type: "script", name: "pc_wake" })} />
            <Tile i={3} on={false} k={t("lightsKey")} n={t("allOff")} onTap={() => { for (const d of st.devices) if (d.entity?.startsWith("light.") && ent(d.entity)?.state === "on") void send({ type: "toggle", entity: d.entity, on: false }, { entity: d.entity, patch: { state: "off" } }); }} />
          </>
        ) : (
          devs.map((d, i) => <DeviceTile key={d.id} i={i} d={d} e={ent(d.entity)} send={send} open={() => openSheet(d)} />)
        )}
      </div>
      {sheet && <Sheet s={sheet} st={st} ent={ent} send={send} close={() => setSheet(null)} />}
    </div>
  );
}

function Tile({ i, on, cool, k, n, v, wide, onTap, onLong }: { i: number; on: boolean; cool?: boolean; k: string; n: string; v?: React.ReactNode; wide?: boolean; onTap?: () => void; onLong?: () => void }) {
  const t = useTranslations("nestHub.kiosk");
  const fx = useTapFx();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = React.useRef(false);
  const tap = () => {
    fx();
    onTap?.();
  };
  return (
    <button
      type="button"
      className={`tile ${on ? "on" : ""} ${cool ? "cool" : ""} ${wide ? "wide" : ""}`}
      style={{ "--i": String(i) } as React.CSSProperties}
      aria-pressed={onTap ? on : undefined}
      aria-haspopup={onLong ? "dialog" : undefined}
      title={onLong ? t("longPressHint") : undefined}
      onPointerDown={() => { fired.current = false; if (onLong) timer.current = setTimeout(() => { fired.current = true; fx(); onLong(); }, 480); }}
      onPointerUp={(e) => { if (timer.current) clearTimeout(timer.current); if (!fired.current && e.pointerType) tap(); fired.current = true; }}
      onPointerLeave={() => { if (timer.current) clearTimeout(timer.current); }}
      // keyboard: Enter/Space tap, the context-menu key / Shift+F10 opens the detail (long-press alternative)
      onClick={(e) => { if (e.detail === 0) tap(); }}
      onContextMenu={(e) => { e.preventDefault(); if (onLong && !fired.current) { fired.current = true; onLong(); } }}
    >
      <span className="k">{k}</span>
      {v !== undefined && <span className="v">{v}</span>}
      <span className="n">{n}</span>
      <i className="dot" aria-hidden />
    </button>
  );
}

function DeviceTile({ i, d, e, send, open }: { i: number; d: Device; e?: Ent; send: Send; open: () => void }) {
  const t = useTranslations("nestHub.kiosk");
  const k = useKioskText();
  const id = d.entity!;
  const on = !!e && !["off", "unavailable", "unknown", "standby", "idle"].includes(e.state);
  const kind = d.kind;
  const un = !e || e.state === "unavailable";
  if (kind === "ac") {
    const cur = num(e?.attributes.current_temperature, NaN);
    const target = num(e?.attributes.temperature, 24);
    return (
      <Tile i={i} cool on={on} k={t("acKey", { state: k.hvac(e?.state) })} n={Number.isFinite(cur) ? t("acRoom", { name: d.name, t: cur }) : d.name} v={<>{target}<small>°</small></>} wide
        onTap={() => void send({ type: "toggle", entity: id, on: !on }, { entity: id, patch: { state: on ? "off" : "cool" } })} onLong={open} />
    );
  }
  if (kind === "sensor") {
    return <Tile i={i} on={false} k={t("sensorKey")} n={d.name} v={<>{k.number(Number(e?.state), 1)}<small>{String(e?.attributes.unit_of_measurement ?? "")}</small></>} />;
  }
  if (kind === "door" || kind === "presence") {
    const yes = e?.state === "on";
    return <Tile i={i} on={yes} k={kind === "door" ? t("doorKey") : t("presenceKey")} n={un ? t("deviceOffline") : kind === "door" ? (yes ? t("open") : t("closed")) : yes ? t("someone") : t("nobody")} />;
  }
  if (kind === "tv" || kind === "display") {
    const title = e?.attributes.media_title as string | undefined;
    return <Tile i={i} on={on} k={String(e?.attributes.app_name ?? kind)} n={title ? `${d.name} · ${title}` : d.name} onTap={() => void send({ type: "media", entity: id, command: on ? "turn_off" : "turn_on" })} onLong={open} />;
  }
  const br = num(e?.attributes.brightness, 0);
  return (
    <Tile i={i} on={on} k={d.via.split(" ")[0] ?? t("lightKey")} n={d.name} v={on && br ? <>{Math.round((br / 255) * 100)}<small>%</small></> : undefined}
      onTap={() => !un && void send({ type: "toggle", entity: id, on: !on }, { entity: id, patch: { state: on ? "off" : "on" } })} onLong={open} />
  );
}

function SheetFrame({ title, sub, close, children }: { title: string; sub: React.ReactNode; close: () => void; children: React.ReactNode }) {
  const t = useTranslations("nestHub.kiosk");
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <>
      <div className="sheet-bg" onPointerDown={close} aria-hidden />
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onPointerDown={stop}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
          <div><h3>{title}</h3><div className="sub">{sub}</div></div>
          <button type="button" className="b sheet-close" aria-label={t("close")} onClick={close}>✕</button>
        </div>
        {children}
      </div>
    </>
  );
}

function Sheet({ s, st, ent, send, close }: { s: Device | "ambilight" | "water"; st: State; ent: (id?: string) => Ent | undefined; send: Send; close: () => void }) {
  const t = useTranslations("nestHub.kiosk");
  const k = useKioskText();
  const fx = useTapFx();
  const press = (fn: () => void) => () => {
    fx();
    fn();
  };
  if (s === "ambilight") {
    const hyper = ent("light.hyperhdr");
    const eff = String(hyper?.attributes.effect ?? "");
    const mode = hyper?.state !== "on" ? "off" : eff.startsWith("Music") ? "music" : "movie";
    return (
      <SheetFrame title="Ambilight" sub={t("ambilightSub")} close={close}>
        <div className="btns">
          {(["movie", "music", "off"] as const).map((md) => (
            <button key={md} type="button" aria-pressed={mode === md} className={`b ${mode === md ? "on" : ""}`} onClick={press(() => void send({ type: "ambilight", mode: md }).then(close))}>
              {t(`mode.${md}`)}
            </button>
          ))}
        </div>
      </SheetFrame>
    );
  }
  if (s === "water") {
    const w = st.nutrition?.water;
    return (
      <SheetFrame title={t("waterTitle")} sub={w ? t("waterSub", { ml: w.ml, target: w.targetMl, g: w.glasses }) : ""} close={close}>
        <div className="btns">
          {[100, 250, 330, 500].map((ml) => <button key={ml} type="button" className="b" onClick={press(() => void send({ type: "water", ml }).then(close))}>{t("addMl", { ml })}</button>)}
          <button type="button" className="b" onClick={press(() => void send({ type: "water_undo" }).then(close))}>{t("undoLast")}</button>
        </div>
      </SheetFrame>
    );
  }
  const d = s;
  const id = d.entity!;
  const e = ent(id);
  if (d.kind === "ac") {
    const target = num(e?.attributes.temperature, 24);
    const cur = num(e?.attributes.current_temperature, NaN);
    const modes = (e?.attributes.hvac_modes as string[] | undefined) ?? ["off", "cool", "heat", "dry", "fan_only", "auto"];
    const fans = (e?.attributes.fan_modes as string[] | undefined) ?? [];
    return (
      <SheetFrame title={d.name} sub={`${Number.isFinite(cur) ? `${t("inRoom", { t: cur })} · ` : ""}${k.hvac(e?.state)}`} close={close}>
        <div className="bigtemp">
          <button type="button" aria-label={t("colder")} onClick={press(() => void send({ type: "climate", entity: id, temperature: target - 1 }, { entity: id, patch: { attributes: { ...(e?.attributes ?? {}), temperature: target - 1 } } }))}>−</button>
          <div className="t" aria-live="polite">{target}°</div>
          <button type="button" aria-label={t("warmer")} onClick={press(() => void send({ type: "climate", entity: id, temperature: target + 1 }, { entity: id, patch: { attributes: { ...(e?.attributes ?? {}), temperature: target + 1 } } }))}>+</button>
        </div>
        <div className="btns">{modes.map((md) => <button key={md} type="button" aria-pressed={e?.state === md} className={`b ${e?.state === md ? "on" : ""}`} onClick={press(() => void send({ type: "climate", entity: id, hvacMode: md }, { entity: id, patch: { state: md } }))}>{k.hvac(md)}</button>)}</div>
        {fans.length > 0 && <div className="btns" role="group" aria-label={t("fan")}>{fans.map((f) => <button key={f} type="button" aria-pressed={e?.attributes.fan_mode === f} className={`b ${e?.attributes.fan_mode === f ? "on" : ""}`} style={{ fontSize: 18 }} onClick={press(() => void send({ type: "climate", entity: id, fanMode: f }))}>{f.replace(/_/g, " ")}</button>)}</div>}
      </SheetFrame>
    );
  }
  if (d.kind === "tv" || d.kind === "display") {
    return (
      <SheetFrame title={d.name} sub={`${String(e?.attributes.app_name ?? "")} ${e?.attributes.media_title ? `· ${String(e.attributes.media_title)}` : ""}`} close={close}>
        <div className="btns">
          {MEDIA_CMDS.map(([c, g]) => (
            <button key={c} type="button" className="b" style={{ fontSize: 30 }} aria-label={t(`media.${c}`)} title={t(`media.${c}`)} onClick={press(() => void send({ type: "media", entity: id, command: c }))}>
              <span aria-hidden>{g}</span>
            </button>
          ))}
        </div>
      </SheetFrame>
    );
  }
  // light
  const on = e?.state === "on";
  const br = Math.round((num(e?.attributes.brightness, 0) / 255) * 100);
  return (
    <SheetFrame title={d.name} sub={on ? t("lightOnSub", { via: d.via, pct: br }) : t("lightOffSub", { via: d.via })} close={close}>
      <input
        className="slider"
        type="range"
        min={1}
        max={100}
        defaultValue={br || 60}
        aria-label={t("brightness")}
        aria-valuetext={`${br || 60} %`}
        onChange={(ev) => void send({ type: "light", entity: id, brightnessPct: Number(ev.currentTarget.value) }, { entity: id, patch: { state: "on", attributes: { ...(e?.attributes ?? {}), brightness: Math.round((Number(ev.currentTarget.value) / 100) * 255) } } })}
      />
      {!d.whiteOnly && (
        <div className="swatches" role="group" aria-label={t("colour")}>
          {SWATCHES.map(([name, c]) => (
            <button key={name} type="button" aria-label={t(`swatch.${name}`)} title={t(`swatch.${name}`)} style={{ background: `rgb(${c.join(",")})` }} onClick={press(() => void send({ type: "light", entity: id, rgb: [...c] }, { entity: id, patch: { state: "on" } }))} />
          ))}
        </div>
      )}
      <div className="btns">
        <button type="button" aria-pressed={!on} className={`b ${!on ? "on" : ""}`} onClick={press(() => void send({ type: "toggle", entity: id, on: false }, { entity: id, patch: { state: "off" } }))}>{t("turnOff")}</button>
        <button type="button" aria-pressed={on} className={`b ${on ? "on" : ""}`} onClick={press(() => void send({ type: "toggle", entity: id, on: true }, { entity: id, patch: { state: "on" } }))}>{t("turnOn")}</button>
        {d.whiteOnly && [2700, 4000, 5500].map((kv) => <button key={kv} type="button" className="b" onClick={press(() => void send({ type: "light", entity: id, kelvin: kv }))}>{kv} K</button>)}
      </div>
    </SheetFrame>
  );
}
