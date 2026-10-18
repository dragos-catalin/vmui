import { Clapperboard, Eraser, Music, Power, RefreshCw, ScanEye, Sparkles, Wand2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { HealthCtx } from "../App";
import { api, hexToRgb, num, same, toast, useAction, useEvent, usePoll, type HyperInstance } from "../lib";
import { usePlatform } from "../platform";
import { Card, Row, Seg, Slider, Swatches, Switch } from "../ui";

type Settings = {
  wallHex: string; wallStrength: number; gamma: number; saturation: number; luminance: number;
  idleStripHex: string; idleGlowHex: string; idleAfterSec: number;
  stripSmoothMs: number; glowSmoothMs: number; roomSmoothMs: number; roomBrightness: number;
  grabberFps: number; hdrToneMapping: boolean; videoFollow: boolean; videoAutoMovie: boolean;
};
const DEF: Settings = { wallHex: "#439ebf", wallStrength: 0.5, gamma: 1, saturation: 1, luminance: 1, idleStripHex: "#a00000", idleGlowHex: "#500000", idleAfterSec: 20, stripSmoothMs: 150, glowSmoothMs: 700, roomSmoothMs: 800, roomBrightness: 140, grabberFps: 60, hdrToneMapping: true, videoFollow: true, videoAutoMovie: true };
const IDLE_COLOURS = ["#000000", "#a00000", "#500000", "#7a3b00", "#3b1f6b", "#0b3d5c", "#1f4d2b"];
const WALLS = ["#439ebf", "#c8b89a", "#e6e1d8", "#9aa3ad", "#b48a6b", "#6b7b8c"];
const EFFECTS = ["Rainbow swirl fast", "Breath", "Candle", "Fire", "Knight rider", "Plasma", "Police Lights Solid", "Sea waves", "Warm mood blobs"];
const KEYS = Object.keys(DEF) as Array<keyof Settings>;

/** Only the keys this page edits, merged over DEF, hex lower-cased: the file may carry extra keys,
 *  miss some, or spell colours in another case — none of that is an unsaved change (D-048). */
function normalize(j: Partial<Settings> | Record<string, unknown>): Settings {
  const src = j as Partial<Settings>;
  const out = { ...DEF };
  for (const k of KEYS) {
    const v = src[k];
    if (v === undefined || v === null || typeof v !== typeof DEF[k]) continue;
    (out as Record<string, unknown>)[k] = typeof v === "string" ? v.toLowerCase() : v;
  }
  return out;
}

export function Ambilight() {
  const { t } = useTranslation();
  const health = React.useContext(HealthCtx);
  const { mobile } = usePlatform();
  const { busy, run } = useAction();
  const [s, setS] = React.useState<Settings>(DEF);
  const [saved, setSaved] = React.useState<Settings>(DEF);
  const [loaded, setLoaded] = React.useState(false);
  const [mode, setMode] = React.useState<string>("?");
  useEvent<string>("mode", setMode);
  const inst = usePoll(() => api.hyperInstances(), 10000);

  React.useEffect(() => {
    if (mobile) return; // settings.json lives on the PC; the phone only drives the live stack
    void api.settingsGet().then((j) => { const m = normalize(j); setS(m); setSaved(m); setLoaded(true); }).catch((e) => toast("error", String(e)));
  }, [mobile]);
  const dirty = loaded && !same(normalize(s), saved);
  const patch = (p: Partial<Settings>) => setS((x) => normalize({ ...x, ...p }));

  const save = () => run("save", async () => {
    await api.settingsSet(s);
    setSaved(normalize(s));
    await api.ambilightConfigure();
  }, t("ambilight.savedApplied"));

  const grabber = health?.grabber ?? false;
  const toggleGrabber = () => run("grab", () => api.hyperSend([{ command: "componentstate", componentstate: { component: "SYSTEMGRABBER", state: !grabber } }], [1, 2, 3]).then(() => api.health()));
  const clear = () => run("clear", () => api.hyperSend([{ command: "clear", priority: 40 }]), t("ambilight.cleared"));
  const effect = (name: string, instances?: number[]) => run(`fx:${name}`, () => api.hyperSend([{ command: "effect", effect: { name }, priority: 40, origin: "vmui desktop" }], instances), `${name}`);
  const solid = (hex: string, instances?: number[]) => run("solid", () => api.hyperSend([{ command: "color", color: hexToRgb(hex), priority: 40, origin: "vmui desktop" }], instances));

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("nav.ambilight")}</h1>
          <p className="text-sm text-muted mt-1">{health?.hyper ? t("ambilight.status", { source: health.source, capture: grabber ? t("ambilight.captureOn") : t("ambilight.captureOff") }) : mobile ? t("ambilight.pcOffline") : t("ambilight.hyperDown")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Seg value={mode} onChange={(m) => run("mode", () => api.ambilightMode(m as "movie" | "music" | "off"))}
            options={[{ id: "movie", label: t("common.movie"), icon: <Clapperboard className="size-4" /> }, { id: "music", label: t("common.music"), icon: <Music className="size-4" /> }, { id: "off", label: t("ambilight.modeOff"), icon: <Power className="size-4" /> }]} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button type="button" className={`tile ${grabber ? "on" : ""}`} onClick={toggleGrabber} disabled={busy === "grab"}>
          <ScanEye className="size-5 text-accent" />
          <div><div className="font-medium">{t("ambilight.capture")}</div><div className="text-xs text-muted">{t("ambilight.captureHint")}</div></div>
        </button>
        <button type="button" className="tile" onClick={clear} disabled={busy === "clear"}>
          <Eraser className="size-5 text-primary" />
          <div><div className="font-medium">{t("ambilight.clear")}</div><div className="text-xs text-muted">{t("ambilight.clearHint")}</div></div>
        </button>
        <button type="button" className="tile" onClick={() => run("restart", () => mobile ? api.pcAction("restart_ambilight") : (async () => { for (const n of ["vmui-ambilight-hyperhdr", "vmui-ambilight-openrgb", "vmui-ambilight-bridges"]) await api.taskAction(n, "restart"); })(), t("ambilight.restarted"))} disabled={busy === "restart"}>
          <RefreshCw className="size-5 text-warn" />
          <div><div className="font-medium">{t("ambilight.restart")}</div><div className="text-xs text-muted">HyperHDR · OpenRGB · bridges</div></div>
        </button>
      </div>

      <Card title={t("ambilight.instances")} sub={t("ambilight.instancesSub")} right={<button type="button" className="btn ghost sm" aria-label={t("common.refresh")} onClick={() => void inst.refresh()}><RefreshCw className="size-3.5" /></button>}>
        {inst.data ? <Instances list={inst.data} onEffect={effect} onSolid={solid} /> : <div className="text-sm text-dim">{inst.error ?? t("common.loading")}</div>}
      </Card>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title={t("ambilight.quickEffects")} sub={t("ambilight.quickEffectsSub")}>
          <div className="flex flex-wrap gap-2">
            {EFFECTS.map((e) => <button key={e} type="button" className="btn sm" onClick={() => effect(e)} disabled={busy === `fx:${e}`}><Sparkles className="size-3.5" />{e}</button>)}
          </div>
          <div className="mt-4 field"><span>{t("ambilight.solid")}</span><Swatches value="#000000" onChange={(hex) => solid(hex)} colors={["#ffffff", "#ffb347", "#ff5a5a", "#5ad1ff", "#7cff9a", "#c084fc", "#ff7ad9"]} /></div>
        </Card>

        {!mobile && <Card title={t("ambilight.idle")} sub={t("ambilight.idleSub")}>
          <div className="field"><span>{t("ambilight.idleStrip")}</span><Swatches value={s.idleStripHex} onChange={(v) => patch({ idleStripHex: v })} colors={IDLE_COLOURS} /></div>
          <div className="field mt-4"><span>{t("ambilight.idleGlow")}</span><Swatches value={s.idleGlowHex} onChange={(v) => patch({ idleGlowHex: v })} colors={IDLE_COLOURS} /></div>
          <div className="field mt-4"><span>{t("ambilight.idleAfter", { s: s.idleAfterSec })}</span><Slider value={s.idleAfterSec} min={3} max={120} onChange={(v) => patch({ idleAfterSec: v })} format={(v) => `${v} s`} /></div>
        </Card>}
      </div>

      {!mobile && <>
      <Card title={t("ambilight.wall")} sub={t("ambilight.wallSub")}>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="grid gap-4">
            <div className="field"><span>{t("ambilight.wallColor")}</span><Swatches value={s.wallHex} onChange={(v) => patch({ wallHex: v })} colors={WALLS} /></div>
            <div className="field"><span>{t("ambilight.compensation")} · {Math.round(s.wallStrength * 100)} %</span><Slider value={s.wallStrength} min={0} max={1} step={0.05} onChange={(v) => patch({ wallStrength: v })} format={(v) => `${Math.round(v * 100)} %`} /></div>
          </div>
          <div className="grid gap-4">
            <div className="field"><span>Gamma · {s.gamma.toFixed(2)}</span><Slider value={s.gamma} min={0.5} max={2.5} step={0.05} onChange={(v) => patch({ gamma: v })} format={(v) => v.toFixed(2)} /></div>
            <div className="field"><span>{t("ambilight.saturation")} · {s.saturation.toFixed(2)}</span><Slider value={s.saturation} min={0.5} max={2} step={0.05} onChange={(v) => patch({ saturation: v })} format={(v) => v.toFixed(2)} /></div>
            <div className="field"><span>{t("ambilight.luminance")} · {s.luminance.toFixed(2)}</span><Slider value={s.luminance} min={0.3} max={1.5} step={0.05} onChange={(v) => patch({ luminance: v })} format={(v) => v.toFixed(2)} /></div>
          </div>
        </div>
      </Card>

      <Card title={t("ambilight.motion")}>
        <Row label={t("ambilight.stripSmooth")} hint={t("ambilight.stripSmoothHint")}><Slider value={s.stripSmoothMs} min={0} max={800} step={10} onChange={(v) => patch({ stripSmoothMs: v })} format={(v) => `${v} ms`} /></Row>
        <Row label={t("ambilight.glowSmooth")}><Slider value={s.glowSmoothMs} min={0} max={2000} step={50} onChange={(v) => patch({ glowSmoothMs: v })} format={(v) => `${v} ms`} /></Row>
        <Row label={t("ambilight.roomSmooth")}><Slider value={s.roomSmoothMs} min={0} max={3000} step={50} onChange={(v) => patch({ roomSmoothMs: v })} format={(v) => `${v} ms`} /></Row>
        <Row label={t("ambilight.roomBrightness")} hint="0–255"><Slider value={s.roomBrightness} min={10} max={255} onChange={(v) => patch({ roomBrightness: v })} /></Row>
        <Row label={t("ambilight.fps")}><Seg value={String(s.grabberFps)} onChange={(v) => patch({ grabberFps: Number(v) })} options={[{ id: "30", label: "30" }, { id: "60", label: "60" }]} /></Row>
        <Row label={t("ambilight.hdr")} hint={t("ambilight.hdrHint")}><Switch checked={s.hdrToneMapping} onChange={(v) => patch({ hdrToneMapping: v })} label={t("ambilight.hdr")} /></Row>
        <Row label={t("ambilight.videoFollow")} hint={t("ambilight.videoFollowHint")}><Switch checked={s.videoFollow} onChange={(v) => patch({ videoFollow: v })} label={t("ambilight.videoFollow")} /></Row>
        <Row label={t("ambilight.autoMovie")} hint={t("ambilight.autoMovieHint")}><Switch checked={s.videoAutoMovie} onChange={(v) => patch({ videoAutoMovie: v })} label={t("ambilight.autoMovie")} /></Row>
      </Card>

      <div className="sticky bottom-3 flex justify-end">
        <div className={`glass flex items-center gap-3 px-4 py-2.5 transition-opacity ${dirty ? "opacity-100" : "opacity-0 pointer-events-none"}`} aria-hidden={!dirty}>
          <span className="text-sm text-muted">{t("common.unsaved")}</span>
          <button type="button" className="btn ghost sm" tabIndex={dirty ? 0 : -1} onClick={() => setS(saved)}>{t("common.discard")}</button>
          <button type="button" className="btn primary" tabIndex={dirty ? 0 : -1} onClick={save} disabled={busy === "save"}><Wand2 className="size-4" />{busy === "save" ? t("ambilight.applying") : t("ambilight.saveApply")}</button>
        </div>
      </div>
      </>}
    </div>
  );
}

function Instances({ list, onEffect, onSolid }: { list: HyperInstance[]; onEffect: (n: string, i?: number[]) => void; onSolid: (hex: string, i?: number[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      {list.map((i) => (
        <div key={i.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
          <span className={`dot ${i.running ? "text-ok bg-ok" : "text-dim bg-dim"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{i.name || t("ambilight.instance", { id: i.id })} <span className="text-dim font-normal">#{i.id}</span></div>
            <div className="text-xs text-muted">{i.running ? `${i.source}${i.grabber != null ? ` · ${t("ambilight.capture")} ${i.grabber ? t("ambilight.captureOn") : t("ambilight.captureOff")}` : ""}${i.brightness != null ? ` · ${num(i.brightness)} %` : ""}` : t("ambilight.stopped")}</div>
          </div>
          {i.running && (
            <>
              <select className="input py-1.5 text-xs" defaultValue="" onChange={(e) => { if (e.target.value) onEffect(e.target.value, [i.id]); e.target.value = ""; }} aria-label={t("ambilight.effectOn", { name: i.name })}>
                <option value="">{t("ambilight.effectPick")}</option>
                {i.effects.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
              <input type="color" aria-label={t("ambilight.colorOn", { name: i.name })} className="h-8 w-9 rounded-lg border border-border bg-transparent p-0.5" onChange={(e) => onSolid(e.target.value, [i.id])} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
