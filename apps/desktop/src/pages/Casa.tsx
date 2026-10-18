import { DoorOpen, Droplets, Lightbulb, MonitorPlay, MoreHorizontal, Radar, Snowflake, Thermometer, Tv, Zap } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { tx } from "../i18n";
import { cn, hexToRgb, num, rgbToHex, useAction, type Ent } from "../lib";
import { SWATCHES } from "../lights";
import { Card, Empty, ErrorState, Loading, PageHeader, Seg, Slider, StaleBadge, Swatches, useFocusTrap } from "../ui";
import { useDisplayState } from "./display-state";

type Device = { id: string; name: string; kind: string; entity?: string; entities?: string[]; room: string; whiteOnly?: boolean; via: string };
const KELVIN = [2700, 3000, 4000, 5000, 6500];
const HVAC = ["off", "cool", "heat", "dry", "fan_only", "auto"] as const;
const MEDIA = ["turn_on", "turn_off", "play_pause", "previous_track", "next_track", "volume_down", "volume_up", "volume_mute"] as const;

export function Casa() {
  const { t } = useTranslation();
  const st = useDisplayState(4000);
  const { busy, run } = useAction();
  const [room, setRoom] = React.useState("bedroom");
  const [open, setOpen] = React.useState<Device | null>(null);
  const s = st.data;

  const send = React.useCallback((body: Record<string, unknown>, optimistic?: { entity: string; patch: Partial<Ent> }) => {
    if (optimistic && st.data) {
      const cur = st.data.entities[optimistic.entity];
      st.setData({ ...st.data, entities: { ...st.data.entities, [optimistic.entity]: { state: optimistic.patch.state ?? cur?.state ?? "", attributes: { ...(cur?.attributes ?? {}), ...(optimistic.patch.attributes ?? {}) } } } });
    }
    return run("send", async () => { await st.control(body); setTimeout(() => void st.refresh(), 800); });
  }, [run, st]);

  if (!s) return st.error ? <ErrorState title={t("common.vmuiDownTitle")} error={st.error} onRetry={() => void st.refresh()} /> : <Loading />;
  const rooms = s.rooms.filter((r) => s.devices.some((d) => d.room === r.id && d.entity));
  const devs = s.devices.filter((d) => d.room === room && d.entity && s.entities[d.entity]);
  const inside = Number(s.inside?.temp?.state);
  const hum = Number(s.inside?.hum?.state);
  const water = s.nutrition?.water;

  return (
    <div className="grid gap-5">
      <PageHeader title={<>{t("nav.casa")} {st.stale && <StaleBadge error={st.error} />}</>}
        sub={<>
          {Number.isFinite(inside) ? t("casa.inside", { temp: inside.toFixed(1) }) + (Number.isFinite(hum) ? ` · ${Math.round(hum)} %` : "") : ""}
          {s.home ? ` · ${t("casa.lightsCount", { on: s.home.lightsOn ?? 0, total: s.home.lightsTotal ?? "–" })} · ${s.home.door?.state === "on" ? t("casa.doorOpen") : t("casa.doorClosed")}` : ""}
        </>}
        actions={<Seg value={room} onChange={setRoom} options={rooms.map((r) => ({ id: r.id, label: tx(`rooms.${r.id}`, r.name) }))} />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {devs.length === 0 && <div className="col-span-full"><Empty text={t("casa.emptyRoom")} illustration="lights" /></div>}
        {devs.map((d) => <Tile key={d.id} d={d} e={s.entities[d.entity!]!} busy={busy === "send"} onTap={() => tap(d, s.entities[d.entity!]!, send)} onOpen={() => setOpen(d)} />)}
      </div>

      <Card title={t("casa.scenes")} sub={t("casa.scenesSub")}>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => send({ type: "ambilight", mode: "movie" })}><MonitorPlay className="size-4" />{t("common.movie")}</button>
          <button type="button" className="btn" onClick={() => send({ type: "ambilight", mode: "music" })}><Zap className="size-4" />{t("common.music")}</button>
          <button type="button" className="btn" onClick={() => send({ type: "ambilight", mode: "off" })}><Lightbulb className="size-4" />{t("casa.warmRoom")}</button>
          <button type="button" className="btn" onClick={() => send({ type: "script", name: "pc_wake" })}>{t("casa.wakePc")}</button>
          <span className="mx-2 w-px bg-border" aria-hidden />
          <button type="button" className="btn" onClick={() => send({ type: "water", ml: 250 })}><Droplets className="size-4" />{t("casa.water")}{water ? <span className="text-muted">· {t("casa.glassesToday", { count: water.glasses })}</span> : null}</button>
          <button type="button" className="btn ghost" onClick={() => send({ type: "water_undo" })}>{t("common.undo")}</button>
        </div>
      </Card>

      {open && open.entity && s.entities[open.entity] && <Sheet d={open} e={s.entities[open.entity]!} onClose={() => setOpen(null)} send={send} />}
    </div>
  );
}

type Send = (body: Record<string, unknown>, optimistic?: { entity: string; patch: Partial<Ent> }) => Promise<void>;

function tap(d: Device, e: Ent, send: Send) {
  const on = e.state !== "off" && e.state !== "unavailable";
  switch (d.kind) {
    case "light":
    case "projector":
      return send({ type: "toggle", entity: d.entity, on: !on }, { entity: d.entity!, patch: { state: on ? "off" : "on" } });
    case "ac":
      return send({ type: "climate", entity: d.entity, hvacMode: on ? "off" : "cool" }, { entity: d.entity!, patch: { state: on ? "off" : "cool" } });
    case "tv":
    case "display":
    case "monitor":
      return send({ type: "media", entity: d.entity, command: on ? "turn_off" : "turn_on" });
    default:
      return Promise.resolve();
  }
}

function Tile({ d, e, busy, onTap, onOpen }: { d: Device; e: Ent; busy: boolean; onTap: () => void; onOpen: () => void }) {
  const { t } = useTranslation();
  const on = e.state !== "off" && e.state !== "unavailable" && e.state !== "unknown";
  const icon = { light: <Lightbulb className="size-5" />, projector: <Lightbulb className="size-5" />, ac: <Snowflake className="size-5" />, tv: <Tv className="size-5" />, display: <MonitorPlay className="size-5" />, monitor: <MonitorPlay className="size-5" />, sensor: <Thermometer className="size-5" />, door: <DoorOpen className="size-5" />, presence: <Radar className="size-5" /> }[d.kind] ?? <Zap className="size-5" />;
  const passive = ["sensor", "door", "presence", "strip", "pc", "proxy"].includes(d.kind);
  const value =
    d.kind === "ac" ? (on ? `${tx(`casa.hvac.${e.state}`, e.state)} · ${num(e.attributes.temperature)}°` : t("common.off")) :
    d.kind === "sensor" ? `${e.state} ${String(e.attributes.unit_of_measurement ?? "")}` :
    d.kind === "door" ? (e.state === "on" ? t("casa.open") : t("casa.closed")) :
    d.kind === "presence" ? (e.state === "on" ? t("casa.presence") : e.state === "unavailable" ? t("common.offline") : t("casa.free")) :
    d.kind === "light" && on && typeof e.attributes.brightness === "number" ? `${Math.round((e.attributes.brightness / 255) * 100)} %` :
    on ? String(e.attributes.app_name ?? t("common.on")) : e.state === "unavailable" ? t("common.unavailable") : t("common.off");
  const rgb = Array.isArray(e.attributes.rgb_color) ? (e.attributes.rgb_color as number[]) : null;
  const tone = on && rgb ? rgbToHex(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0) : undefined;
  const body = (
    <>
      <span style={tone ? { color: tone } : undefined} className={cn(!tone && (on ? "text-lit-text" : "text-muted"))}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-muted truncate" title={d.via}>{d.via}</div>
        <div className="font-medium truncate" title={d.name}>{d.name}</div>
        <div className={cn("text-sm tabular-nums truncate", on ? "text-fg" : "text-muted")}>{value}</div>
      </div>
    </>
  );
  const cls = cn("tile", on && !passive && (d.kind === "ac" ? "cool" : "on"));
  if (passive) return <div className={cls}>{body}</div>;
  // a real <button>: Enter AND Space, and no click while an action is in flight (DK-21)
  return (
    <div className="relative">
      <button type="button" className={cn(cls, "pr-12")} aria-pressed={on} aria-disabled={busy || undefined}
        onClick={() => { if (!busy) onTap(); }} onContextMenu={(ev) => { ev.preventDefault(); onOpen(); }}>
        {body}
      </button>
      <button type="button" className="btn ghost sm tile-more" onClick={onOpen} aria-label={t("casa.settingsFor", { name: d.name })} aria-haspopup="dialog"><MoreHorizontal className="size-4" /></button>
    </div>
  );
}

function Sheet({ d, e, onClose, send }: { d: Device; e: Ent; onClose: () => void; send: Send }) {
  const { t } = useTranslation();
  const [bri, setBri] = React.useState(Math.round(num(e.attributes.brightness, 255) / 255 * 100));
  const rgb = Array.isArray(e.attributes.rgb_color) ? (e.attributes.rgb_color as number[]) : [255, 200, 120];
  const [hex, setHex] = React.useState(rgbToHex(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0));
  const temp = num(e.attributes.temperature, 24);
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(ref, onClose);
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div ref={ref} className="glass float max-h-[90vh] w-full max-w-[460px] overflow-y-auto p-5" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(ev) => ev.stopPropagation()}>
        <h3 id={titleId} className="text-lg font-semibold break-words">{d.name}</h3>
        <p className="text-xs text-muted mb-4">{d.via} · {e.state}</p>
        {(d.kind === "light" || d.kind === "projector") && (
          <div className="grid gap-4">
            <div className="field"><span>{t("common.brightness")} · {bri} %</span><Slider value={bri} min={1} max={100} onChange={setBri} onCommit={(v) => void send({ type: "light", entity: d.entity, brightnessPct: v })} format={(v) => `${v} %`} /></div>
            {!d.whiteOnly && <div className="field"><span>{t("common.color")}</span><Swatches value={hex} onChange={(h) => { setHex(h); void send({ type: "light", entity: d.entity, rgb: hexToRgb(h) }); }} colors={SWATCHES} /></div>}
            <div className="field"><span>{t("common.white")}</span><div className="flex flex-wrap gap-2">{KELVIN.map((k) => <button key={k} type="button" className="btn sm" onClick={() => void send({ type: "light", entity: d.entity, kelvin: k })}>{k} K</button>)}</div></div>
          </div>
        )}
        {d.kind === "ac" && (
          <div className="grid gap-4">
            <div className="flex items-center justify-center gap-6">
              <button type="button" className="btn text-xl" aria-label={t("casa.tempDown")} onClick={() => void send({ type: "climate", entity: d.entity, temperature: Math.max(16, temp - 1) })}>−</button>
              <div className="text-5xl font-light tabular-nums">{temp}°</div>
              <button type="button" className="btn text-xl" aria-label={t("casa.tempUp")} onClick={() => void send({ type: "climate", entity: d.entity, temperature: Math.min(30, temp + 1) })}>+</button>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {HVAC.map((m) => <button key={m} type="button" aria-pressed={e.state === m} className={cn("btn sm", e.state === m && "on")} onClick={() => void send({ type: "climate", entity: d.entity, hvacMode: m })}>{t(`casa.hvac.${m}`)}</button>)}
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {(e.attributes.fan_modes as string[] | undefined)?.map((f) => <button key={f} type="button" className={cn("btn sm", e.attributes.fan_mode === f && "on")} onClick={() => void send({ type: "climate", entity: d.entity, fanMode: f })}>{f}</button>)}
            </div>
          </div>
        )}
        {["tv", "display", "monitor"].includes(d.kind) && (
          <div className="flex flex-wrap gap-2">
            {MEDIA.map((c) => <button key={c} type="button" className="btn sm" onClick={() => void send({ type: "media", entity: d.entity, command: c })}>{t(`casa.media.${c}`)}</button>)}
          </div>
        )}
        <div className="mt-5 flex justify-end"><button type="button" className="btn ghost" onClick={onClose}>{t("common.close")}</button></div>
      </div>
    </div>
  );
}
