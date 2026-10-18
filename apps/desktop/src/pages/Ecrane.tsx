import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, ExternalLink, Image as ImageIcon, MonitorSmartphone, Save, Tablet } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { api, cn, toast, useAction } from "../lib";
import { SCREEN_ACCENTS } from "../lights";
import { Card, ErrorState, Loading, PageHeader, Row, Seg, Slider, Swatches, Switch } from "../ui";

type TurzxView = { id: string; enabled: boolean; dwellSec: number; skin: string; background: null | { mode: "none" | "photo"; sources: string[]; folder: string; dim: number; blur: number }; options: Record<string, unknown> };
type Turzx = { version: 2; views: TurzxView[]; fps: number; transitionMs: number; brightness: number; nightBrightness: number; nightFrom: string; nightTo: string; accent: string; flip: boolean; background: { mode: "none" | "photo"; sources: string[]; folder: string; dim: number; blur: number }; bgRotateMin: number; notify: { enabled: boolean; presenceOnly: boolean; durationSec: number; showText: boolean; position: "top" | "center" | "bottom"; packages: string[] } };
type DisplayView = { id: string; enabled: boolean; dwellSec: number; photo: boolean };
type Display = { version: 1; views: DisplayView[]; photoSources: string[]; photoSec: number; dim: number; nightFrom: string; nightTo: string; nightDim: number; idleAfterSec: number; accent: string; cast: { device: string; keepAlive: boolean; respectPlayback: boolean } };
type Meta = {
  turzxViews: Record<string, { label: string; description: string; skins: string[] }>;
  turzxSkins: Array<{ id: string; label: string; description: string }>;
  displayViews: Record<string, { label: string; description: string }>;
  photoSources: Array<{ id: string; label: string; description: string }>;
};
type Payload = { turzx: Turzx; display: Display; meta: Meta };

const ACCENTS = SCREEN_ACCENTS;

export function Ecrane() {
  const { t } = useTranslation();
  const [p, setP] = React.useState<Payload | null>(null);
  const [saved, setSaved] = React.useState<Payload | null>(null);
  const [tab, setTab] = React.useState<"hub" | "turzx">("hub");
  const [err, setErr] = React.useState<string | null>(null);
  const { busy, run } = useAction();
  const load = React.useCallback(() => api.vmuiGet<Payload>("/api/desktop/settings").then((j) => { setP(j); setSaved(j); setErr(null); }).catch((e) => setErr(String(e))), []);
  React.useEffect(() => void load(), [load]);

  if (!p || !saved) return err ? <ErrorState title={t("common.vmuiDownTitle")} error={err} onRetry={() => void load()} /> : <Loading />;
  const dirty = tab === "hub" ? JSON.stringify(p.display) !== JSON.stringify(saved.display) : JSON.stringify(p.turzx) !== JSON.stringify(saved.turzx);
  const save = () => run("save", async () => {
    await api.vmuiSend("PUT", "/api/desktop/settings", tab === "hub" ? { display: p.display } : { turzx: p.turzx });
    setSaved(p);
  }, tab === "hub" ? t("ecrane.hubSaved") : t("ecrane.turzxSaved"));

  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.ecrane")} sub={t("ecrane.sub")}
        actions={<Seg value={tab} onChange={setTab} options={[{ id: "hub", label: "Nest Hub", icon: <Tablet className="size-4" /> }, { id: "turzx", label: "Turzx 3.5\"", icon: <MonitorSmartphone className="size-4" /> }]} />} />

      {tab === "hub" ? <Hub d={p.display} meta={p.meta} set={(d) => setP({ ...p, display: d })} /> : <TurzxPane t={p.turzx} meta={p.meta} set={(t) => setP({ ...p, turzx: t })} />}

      <div className="sticky bottom-3 flex justify-end">
        <div className={cn("glass float flex flex-wrap items-center gap-3 px-4 py-2.5 transition-opacity", dirty ? "opacity-100" : "opacity-0 pointer-events-none")} aria-hidden={!dirty}>
          <span className="text-sm text-muted">{t("common.unsaved")}</span>
          <button type="button" className="btn ghost sm" tabIndex={dirty ? 0 : -1} onClick={() => setP(saved)}>{t("common.discard")}</button>
          <button type="button" className="btn primary" tabIndex={dirty ? 0 : -1} onClick={save} disabled={busy === "save"}><Save className="size-4" />{busy === "save" ? t("common.saving") : t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}

function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const n = [...arr];
  [n[i], n[j]] = [n[j]!, n[i]!];
  return n;
}

function Hub({ d, meta, set }: { d: Display; meta: Meta; set: (d: Display) => void }) {
  const { t } = useTranslation();
  const on = d.views.filter((v) => v.enabled);
  const cycle = on.reduce((a, v) => a + v.dwellSec, 0);
  const setView = (id: string, patch: Partial<DisplayView>) => set({ ...d, views: d.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  return (
    <>
      <Card title={t("ecrane.hubPanels")} sub={t("ecrane.cycle", { n: on.length, m: Math.floor(cycle / 60), s: cycle % 60 }) + " " + t("ecrane.hubMusic")}
        right={<button type="button" className="btn ghost sm" onClick={() => void api.appInfo().then((i) => openUrl(i.displayUrl)).catch((e) => toast("error", String(e)))}><ExternalLink className="size-3.5" />/display</button>}>
        <div className="grid gap-2">
          {d.views.map((v, i) => {
            const m = meta.displayViews[v.id];
            return (
              <div key={v.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2", v.enabled ? "border-primary/40 bg-primary/5" : "border-border opacity-70")}>
                <Switch checked={v.enabled} onChange={(en) => setView(v.id, { enabled: en })} label={m?.label} />
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate text-sm font-medium" title={m?.label ?? v.id}>{m?.label ?? v.id} <span className="text-muted font-normal tabular-nums">· {v.dwellSec} s</span></div>
                  <div className="text-xs text-muted truncate" title={m?.description}>{m?.description}</div>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted"><ImageIcon className="size-3.5" /><Switch checked={v.photo} onChange={(ph) => setView(v.id, { photo: ph })} label={t("ecrane.photo")} /></label>
                <div className="w-full min-w-32 max-w-40 basis-40"><Slider value={v.dwellSec} min={5} max={180} step={5} onChange={(n) => setView(v.id, { dwellSec: n })} format={(n) => `${n} s`} /></div>
                <button type="button" className="btn ghost sm" aria-label={t("common.moveUp")} disabled={i === 0} onClick={() => set({ ...d, views: move(d.views, i, -1) })}><ArrowUp className="size-3.5" /></button>
                <button type="button" className="btn ghost sm" aria-label={t("common.moveDown")} disabled={i === d.views.length - 1} onClick={() => set({ ...d, views: move(d.views, i, 1) })}><ArrowDown className="size-3.5" /></button>
              </div>
            );
          })}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title={t("ecrane.photos")}>
          <div className="flex flex-wrap gap-2 mb-4">
            {meta.photoSources.map((s) => (
              <button key={s.id} type="button" title={s.description} aria-pressed={d.photoSources.includes(s.id)} className={cn("btn sm", d.photoSources.includes(s.id) && "on")}
                onClick={() => set({ ...d, photoSources: d.photoSources.includes(s.id) ? d.photoSources.filter((x) => x !== s.id) : [...d.photoSources, s.id] })}>{s.label}</button>
            ))}
          </div>
          <div className="field"><span>{t("ecrane.photoEvery")} · {d.photoSec} s</span><Slider value={d.photoSec} min={10} max={300} step={5} onChange={(n) => set({ ...d, photoSec: n })} format={(n) => `${n} s`} /></div>
          <div className="field mt-3"><span>{t("ecrane.dim")} · {Math.round(d.dim * 100)} %</span><Slider value={d.dim} min={0} max={0.9} step={0.05} onChange={(n) => set({ ...d, dim: n })} format={(n) => `${Math.round(n * 100)} %`} /></div>
          <div className="field mt-3"><span>{t("ecrane.accent")}</span><Swatches value={d.accent} onChange={(c) => set({ ...d, accent: c })} colors={ACCENTS} /></div>
        </Card>
        <Card title={t("ecrane.behaviour")}>
          <div className="field"><span>{t("ecrane.idleAfter", { s: d.idleAfterSec })}</span><Slider value={d.idleAfterSec} min={10} max={300} step={5} onChange={(n) => set({ ...d, idleAfterSec: n })} format={(n) => `${n} s`} /></div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="field"><span>{t("ecrane.nightFrom")}</span><input className="input" type="time" value={d.nightFrom} onChange={(e) => set({ ...d, nightFrom: e.target.value })} /></label>
            <label className="field"><span>{t("ecrane.nightTo")}</span><input className="input" type="time" value={d.nightTo} onChange={(e) => set({ ...d, nightTo: e.target.value })} /></label>
          </div>
          <div className="field mt-3"><span>{t("ecrane.nightBrightness")} · {Math.round(d.nightDim * 100)} %</span><Slider value={d.nightDim} min={0.05} max={1} step={0.05} onChange={(n) => set({ ...d, nightDim: n })} format={(n) => `${Math.round(n * 100)} %`} /></div>
          <label className="field mt-3"><span>{t("ecrane.castDevice")}</span><input className="input" value={d.cast.device} onChange={(e) => set({ ...d, cast: { ...d.cast, device: e.target.value } })} /></label>
          <Row label={t("ecrane.keepAlive")} hint={t("ecrane.keepAliveHint")}><Switch checked={d.cast.keepAlive} onChange={(v) => set({ ...d, cast: { ...d.cast, keepAlive: v } })} label={t("ecrane.keepAlive")} /></Row>
          <Row label={t("ecrane.respectPlayback")}><Switch checked={d.cast.respectPlayback} onChange={(v) => set({ ...d, cast: { ...d.cast, respectPlayback: v } })} label={t("ecrane.respectPlayback")} /></Row>
        </Card>
      </div>
    </>
  );
}

function TurzxPane({ t, meta, set }: { t: Turzx; meta: Meta; set: (t: Turzx) => void }) {
  const { t: tr } = useTranslation();
  const on = t.views.filter((v) => v.enabled);
  const cycle = on.reduce((a, v) => a + v.dwellSec, 0);
  const setView = (id: string, patch: Partial<TurzxView>) => set({ ...t, views: t.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  return (
    <>
      <Card title={tr("ecrane.views")} sub={tr("ecrane.cycle", { n: on.length, m: Math.floor(cycle / 60), s: cycle % 60 })}>
        <div className="grid gap-2">
          {t.views.map((v, i) => {
            const m = meta.turzxViews[v.id];
            return (
              <div key={v.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2", v.enabled ? "border-primary/40 bg-primary/5" : "border-border opacity-70")}>
                <Switch checked={v.enabled} onChange={(en) => setView(v.id, { enabled: en })} label={m?.label} />
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate text-sm font-medium" title={m?.label ?? v.id}>{m?.label ?? v.id} <span className="text-muted font-normal tabular-nums">· {v.dwellSec} s</span></div>
                  <div className="text-xs text-muted truncate" title={m?.description}>{m?.description}</div>
                </div>
                <select className="input py-1.5 text-xs" value={v.skin} onChange={(e) => setView(v.id, { skin: e.target.value })} aria-label={tr("ecrane.skinFor", { name: m?.label ?? v.id })}>
                  {(m?.skins ?? meta.turzxSkins.map((s) => s.id)).map((s) => <option key={s} value={s}>{meta.turzxSkins.find((x) => x.id === s)?.label ?? s}</option>)}
                </select>
                <div className="w-full min-w-32 max-w-36 basis-36"><Slider value={v.dwellSec} min={5} max={120} step={5} onChange={(n) => setView(v.id, { dwellSec: n })} format={(n) => `${n} s`} /></div>
                <button type="button" className="btn ghost sm" aria-label={tr("common.moveUp")} disabled={i === 0} onClick={() => set({ ...t, views: move(t.views, i, -1) })}><ArrowUp className="size-3.5" /></button>
                <button type="button" className="btn ghost sm" aria-label={tr("common.moveDown")} disabled={i === t.views.length - 1} onClick={() => set({ ...t, views: move(t.views, i, 1) })}><ArrowDown className="size-3.5" /></button>
              </div>
            );
          })}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title={tr("ecrane.screen")}>
          <div className="field"><span>{tr("common.brightness")} · {t.brightness} %</span><Slider value={t.brightness} min={5} max={100} onChange={(n) => set({ ...t, brightness: n })} format={(n) => `${n} %`} /></div>
          <div className="field mt-3"><span>{tr("ecrane.atNight")} · {t.nightBrightness} %</span><Slider value={t.nightBrightness} min={0} max={100} onChange={(n) => set({ ...t, nightBrightness: n })} format={(n) => `${n} %`} /></div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="field"><span>{tr("ecrane.nightFrom")}</span><input className="input" type="time" value={t.nightFrom} onChange={(e) => set({ ...t, nightFrom: e.target.value })} /></label>
            <label className="field"><span>{tr("ecrane.nightTo")}</span><input className="input" type="time" value={t.nightTo} onChange={(e) => set({ ...t, nightTo: e.target.value })} /></label>
          </div>
          <div className="field mt-3"><span>FPS · {t.fps}</span><Slider value={t.fps} min={5} max={30} onChange={(n) => set({ ...t, fps: n })} /></div>
          <div className="field mt-3"><span>{tr("ecrane.transition")} · {t.transitionMs} ms</span><Slider value={t.transitionMs} min={0} max={2000} step={50} onChange={(n) => set({ ...t, transitionMs: n })} format={(n) => `${n} ms`} /></div>
          <div className="field mt-3"><span>{tr("ecrane.accent")}</span><Swatches value={t.accent} onChange={(c) => set({ ...t, accent: c })} colors={ACCENTS} /></div>
          <Row label={tr("ecrane.flip")} hint={tr("ecrane.flipHint")}><Switch checked={t.flip} onChange={(v) => set({ ...t, flip: v })} label={tr("ecrane.flip")} /></Row>
        </Card>
        <Card title={tr("ecrane.bgNotify")}>
          <Row label={tr("ecrane.bgPhotos")}><Switch checked={t.background.mode === "photo"} onChange={(v) => set({ ...t, background: { ...t.background, mode: v ? "photo" : "none" } })} label={tr("ecrane.bgPhotos")} /></Row>
          <div className="flex flex-wrap gap-2 my-3">
            {meta.photoSources.map((s) => (
              <button key={s.id} type="button" title={s.description} aria-pressed={t.background.sources.includes(s.id)} className={cn("btn sm", t.background.sources.includes(s.id) && "on")}
                onClick={() => set({ ...t, background: { ...t.background, sources: t.background.sources.includes(s.id) ? t.background.sources.filter((x) => x !== s.id) : [...t.background.sources, s.id] } })}>{s.label}</button>
            ))}
          </div>
          <div className="field"><span>{tr("ecrane.dim")} · {Math.round(t.background.dim * 100)} %</span><Slider value={t.background.dim} min={0} max={0.9} step={0.05} onChange={(n) => set({ ...t, background: { ...t.background, dim: n } })} format={(n) => `${Math.round(n * 100)} %`} /></div>
          <div className="field mt-3"><span>{tr("ecrane.photoEvery")} · {t.bgRotateMin} min</span><Slider value={t.bgRotateMin} min={1} max={240} onChange={(n) => set({ ...t, bgRotateMin: n })} format={(n) => `${n} min`} /></div>
          <div className="mt-4 border-t border-border pt-2">
            <Row label={tr("ecrane.phoneNotif")}><Switch checked={t.notify.enabled} onChange={(v) => set({ ...t, notify: { ...t.notify, enabled: v } })} label={tr("ecrane.phoneNotif")} /></Row>
            <Row label={tr("ecrane.presenceOnly")} hint={tr("ecrane.presenceOnlyHint")}><Switch checked={t.notify.presenceOnly} onChange={(v) => set({ ...t, notify: { ...t.notify, presenceOnly: v } })} label={tr("ecrane.presenceOnly")} /></Row>
            <Row label={tr("ecrane.showText")}><Switch checked={t.notify.showText} onChange={(v) => set({ ...t, notify: { ...t.notify, showText: v } })} label={tr("ecrane.showText")} /></Row>
            <Row label={tr("ecrane.position")}><Seg value={t.notify.position} onChange={(v) => set({ ...t, notify: { ...t.notify, position: v } })} options={[{ id: "top", label: tr("ecrane.top") }, { id: "center", label: tr("ecrane.center") }, { id: "bottom", label: tr("ecrane.bottom") }]} /></Row>
            <div className="field mt-2"><span>{tr("ecrane.duration")} · {t.notify.durationSec} s</span><Slider value={t.notify.durationSec} min={2} max={30} onChange={(n) => set({ ...t, notify: { ...t.notify, durationSec: n } })} format={(n) => `${n} s`} /></div>
          </div>
        </Card>
      </div>
    </>
  );
}
