import { Crosshair } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { tx } from "./i18n";
import { api, cn, hexToRgb, rgbToHex, toast } from "./lib";
import { KELVIN_STEPS, LIGHT_SWATCHES, stateColor, type BleStatus, type LightDevice, type LightState, type LightsPayload, type Segment } from "./lights";
import { Slider, Swatches, Switch } from "./ui";

export type LightsApi = ReturnType<typeof useLights>;

/** Registry from homepi via `lights_get`, polled while visible; every mutation is optimistic,
 *  then re-read after 800 ms so the server's applied/downgraded state wins. */
export function useLights(pollMs = 5000) {
  const [data, setData] = React.useState<LightsPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [ble, setBle] = React.useState<Record<string, BleStatus>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const timer = React.useRef<number | undefined>(undefined);

  const refresh = React.useCallback(async () => {
    try {
      const d = await api.lightsGet();
      setData(d);
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
    api.bleStatus().then((l) => setBle(Object.fromEntries(l.map((s) => [s.mac.toUpperCase(), s])))).catch(() => undefined);
  }, []);
  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => document.visibilityState === "visible" && void refresh(), pollMs);
    return () => { clearInterval(id); window.clearTimeout(timer.current); };
  }, [refresh, pollMs]);
  const later = React.useCallback(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void refresh(), 800); }, [refresh]);

  /** Every op goes through here: busy flag, toast on failure, delayed refresh. */
  const op = React.useCallback(async <T = unknown,>(body: Record<string, unknown>, opts?: { ok?: string; key?: string; quiet?: boolean }): Promise<T | undefined> => {
    setBusy(opts?.key ?? String(body.op));
    try {
      const r = await api.lightsOp<T>(body);
      if (opts?.ok) toast("ok", opts.ok);
      return r;
    } catch (e) {
      if (!opts?.quiet) toast("error", String(e).replace(/^Error:\s*/, ""));
      throw e;
    } finally {
      setBusy(null);
      later();
    }
  }, [later]);

  const patchDevices = React.useCallback((match: (d: LightDevice) => boolean, f: (d: LightDevice) => LightDevice) =>
    setData((cur) => (cur ? { ...cur, devices: cur.devices.map((d) => (match(d) ? f(d) : d)) } : cur)), []);

  /** set {target, state} with an optimistic merge on every device the target resolves to locally. */
  const set = React.useCallback((target: string, state: LightState) => {
    const [kind, id] = target.includes(":") ? [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)] : [target, ""];
    const members = kind === "group" ? new Set(data?.groups.find((g) => g.id === id)?.members ?? []) : null;
    const match = (d: LightDevice) =>
      kind === "all" || (kind === "dev" && d.id === id) || (kind === "room" && d.room === id) || (kind === "seg" && d.segments.some((s) => s.id === id)) ||
      (!!members && (members.has(`dev:${d.id}`) || d.segments.some((s) => members.has(`seg:${s.id}`))));
    patchDevices(match, (d) => ({ ...d, state: state.on ? { ...(d.state ?? { on: true }), ...state } : { ...(d.state ?? {}), on: false } }));
    return op({ op: "set", target, state }, { key: `set:${target}` }).catch(() => undefined);
  }, [data, op, patchDevices]);

  return { data, error, ble, busy, refresh, op, set, setData, patchDevices };
}

export function HealthDot({ d, ble }: { d: LightDevice; ble?: BleStatus | undefined }) {
  const { t } = useTranslation();
  const h = ble && !ble.connected && d.health === "ok" ? "degraded" : d.health;
  const latency = ble?.latencyMs ?? d.lastLatencyMs;
  const label = `${tx(`lights.health.${h}`, h)}${latency != null ? ` · ${latency} ms` : ""}${d.lastError ? ` · ${d.lastError}` : ""}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted tabular-nums" title={label}>
      <span className={cn("dot", h === "ok" && "text-ok bg-ok", h === "degraded" && "text-warn bg-warn", h === "offline" && "text-down bg-down", h === "unknown" && "text-dim bg-dim")} aria-hidden />
      <span className="sr-only">{t("lights.healthLabel")}: </span>{latency != null ? `${latency} ms` : tx(`lights.health.${h}`, h)}
    </span>
  );
}

/** One cell per segment (width ∝ LED count) in the colour the device shows now; addressable strips only. */
export function StripPreview({ d, segments, className }: { d: LightDevice; segments?: Segment[]; className?: string }) {
  const { t } = useTranslation();
  const segs = segments ?? d.segments;
  const color = stateColor(d.state);
  const total = Math.max(1, segs.reduce((a, s) => a + s.ledCount, 0));
  const cells = segs.length ? segs : [{ id: "all", name: d.name, ledCount: 1, ledStart: 0 } as Segment];
  return (
    <div className={cn("flex h-2.5 overflow-hidden rounded-full border border-border bg-bg-2", className)} role="img"
      aria-label={t("lights.previewLabel", { name: d.name, n: segs.length || 1, leds: d.ledCount })}>
      {cells.map((s, i) => (
        <div key={s.id} className={cn("h-full", i > 0 && "border-l border-bg")} title={`${s.name} · ${s.ledCount} LED`}
          style={{ width: `${(s.ledCount / (segs.length ? total : 1)) * 100}%`, background: color ?? undefined }} />
      ))}
    </div>
  );
}

const showPreview = (d: LightDevice) => d.capabilities.addressable || d.capabilities.segments;

/** Every control the device's capabilities allow. `compact` hides the colour/kelvin/effect row behind a toggle. */
export function LightControls({ d, lights, target, compact = false }: { d: LightDevice; lights: LightsApi; target?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const caps = d.capabilities;
  const tg = target ?? `dev:${d.id}`;
  const st = d.state ?? { on: false };
  const [bri, setBri] = React.useState(st.brightnessPct ?? 100);
  const [open, setOpen] = React.useState(!compact);
  React.useEffect(() => { if (st.brightnessPct != null) setBri(st.brightnessPct); }, [st.brightnessPct]);
  const hex = st.rgb ? rgbToHex(...st.rgb) : "#ffffff";
  const colour = caps.rgb && !caps.whiteOnly;
  const hasMore = colour || !!caps.kelvin || caps.effects.length > 0;
  const off = !d.enabled;

  return (
    <div className={cn("grid gap-3", off && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-3">
        <Switch checked={st.on} onChange={(on) => void lights.set(tg, { on })} label={t("lights.toggle", { name: d.name })} />
        {caps.brightness && (
          <div className="min-w-[180px] flex-1">
            <Slider value={bri} min={1} max={100} onChange={setBri} onCommit={(v) => void lights.set(tg, { on: true, brightnessPct: v })} format={(v) => `${v} %`} />
          </div>
        )}
        <button type="button" className="btn ghost sm" disabled={lights.busy === `identify:${d.id}`} onClick={() => void lights.op({ op: "identify", id: d.id }, { key: `identify:${d.id}`, ok: t("lights.identifySent", { name: d.name }) }).catch(() => undefined)}>
          <Crosshair className="size-3.5" />{t("lights.identify")}
        </button>
        {compact && hasMore && <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? t("lights.less") : t("lights.more")}</button>}
      </div>
      {open && hasMore && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {colour && <Swatches value={hex} colors={LIGHT_SWATCHES} onChange={(h) => void lights.set(tg, { on: true, rgb: hexToRgb(h) })} />}
          {caps.kelvin && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("common.white")}>
              {KELVIN_STEPS.filter((k) => k >= caps.kelvin![0] && k <= caps.kelvin![1]).map((k) => (
                <button key={k} type="button" aria-pressed={st.kelvin === k} className={cn("btn sm", st.kelvin === k && "on")} onClick={() => void lights.set(tg, { on: true, kelvin: k })}>{k} K</button>
              ))}
            </div>
          )}
          {caps.effects.length > 0 && (
            <select className="input py-1.5 text-xs" value={st.effect ?? ""} aria-label={t("lights.effect")} onChange={(e) => e.target.value && void lights.set(tg, { on: true, effect: e.target.value })}>
              <option value="">{t("lights.effectPick")}</option>
              {caps.effects.map((fx) => <option key={fx} value={fx}>{fx}</option>)}
            </select>
          )}
        </div>
      )}
      {showPreview(d) && <StripPreview d={d} />}
    </div>
  );
}

export { showPreview };
