"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SettingsPanel, Subsection } from "@/components/ui/settings-panel";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { type DisplaySettings, type DisplayView } from "@/lib/display/settings-meta";
import { TURZX_BG_SOURCES, type TurzxBgSource } from "@/lib/turzx/catalog";
import { cn } from "@/lib/utils";
import { saveDisplaySettingsAction } from "@/server/actions/home";
import { ArrowDown, ArrowUp, ExternalLink, Tablet } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { DEVICE_ACCENTS } from "./accent-swatches";
import { useHomeAction } from "./use-home-action";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Settings for the Nest Hub kiosk (/display). Saved to the same table as Turzx, row 4. */
export function DisplayCard({ initial, espToken, defaultOpen = false }: { initial: DisplaySettings; espToken: string; defaultOpen?: boolean }) {
  const t = useTranslations("nestHub");
  // photo sources are shared with the Turzx screen, so their text lives in that namespace
  const sources = useTranslations("turzx.sources");
  const [s, setS] = React.useState<DisplaySettings>(initial);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const saveAction = useHomeAction(saveDisplaySettingsAction, { success: t("saved"), error: t("saveFailed"), refresh: true });
  const busy = saveAction.pending;

  const setView = (id: string, patch: Partial<DisplayView>) => setS((p) => ({ ...p, views: p.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));
  const move = (id: string, dir: -1 | 1) =>
    setS((p) => {
      const i = p.views.findIndex((v) => v.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.views.length) return p;
      const next = [...p.views];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...p, views: next };
    });
  const toggleSource = (src: TurzxBgSource) =>
    setS((p) => ({ ...p, photoSources: p.photoSources.includes(src) ? p.photoSources.filter((x) => x !== src) : [...p.photoSources, src] }));

  const save = () => void saveAction.run(s);

  const on = s.views.filter((v) => v.enabled);
  const cycle = on.reduce((a, v) => a + v.dwellSec, 0);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/display?k=${espToken}`;
  const pct = (x: number) => Math.round(x * 100);

  return (
    <SettingsPanel
      id="nest-hub"
      icon={<Tablet aria-hidden />}
      title={t("title")}
      summary={t("summary", { count: on.length, min: Math.floor(cycle / 60), sec: cycle % 60, sec2: s.photoSec })}
      defaultOpen={defaultOpen}
      action={
        <div className="flex items-center gap-2">
          {url ? (
            <Button size="sm" variant="ghost" asChild>
              <a href={url} target="_blank" rel="noreferrer" aria-label={t("openAria")}><ExternalLink className="size-4" aria-hidden /> <span className="hidden sm:inline">{t("open")}</span></a>
            </Button>
          ) : null}
          <Button size="sm" onClick={save} disabled={!dirty || busy} loading={busy}>{busy ? t("saving") : t("save")}</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Subsection title={t("views.title")} hint={t("views.hint")}>
          <ul className="space-y-2">
            {s.views.map((v, i) => {
              const name = t(`views.${v.id}.label`);
              const description = t(`views.${v.id}.description`);
              return (
                <li key={v.id} className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 transition", v.enabled ? "border-primary/40 bg-primary/5" : "border-border opacity-70")}>
                  <Switch checked={v.enabled} onCheckedChange={(en) => setView(v.id, { enabled: en })} aria-label={t("views.enabledAria", { name })} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium leading-tight" title={name}>{name}</span>
                      <Badge variant="muted" className="shrink-0">{t("views.seconds", { n: v.dwellSec })}</Badge>
                    </div>
                    <p className="line-clamp-2 text-xs leading-snug text-muted" title={description}>{description}</p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button size="icon" variant="ghost" aria-label={t("views.moveUp")} onClick={() => move(v.id, -1)} disabled={i === 0}><ArrowUp className="size-4" aria-hidden /></Button>
                    <Button size="icon" variant="ghost" aria-label={t("views.moveDown")} onClick={() => move(v.id, 1)} disabled={i === s.views.length - 1}><ArrowDown className="size-4" aria-hidden /></Button>
                  </div>
                  <div className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-3">
                    <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      <Switch checked={v.photo} onCheckedChange={(ph) => setView(v.id, { photo: ph })} aria-label={t("views.photoAria", { name })} />
                      {t("views.withPhoto")}
                    </label>
                    <label className="flex min-w-[10rem] flex-1 items-center gap-2 text-xs text-muted">
                      <span className="shrink-0">{t("views.dwell")}</span>
                      <Slider value={v.dwellSec} min={5} max={180} step={5} onChange={(n) => setView(v.id, { dwellSec: n })} aria-label={t("views.dwellAria", { name })} className="min-w-0 flex-1" />
                    </label>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={5}
                      max={180}
                      step={5}
                      value={v.dwellSec}
                      onChange={(e) => setView(v.id, { dwellSec: Math.min(180, Math.max(5, Number(e.target.value) || 5)) })}
                      aria-label={t("views.dwellAria", { name })}
                      className="w-24 shrink-0 tabular-nums"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Subsection>

        <Subsection title={t("photos.title")} collapsible defaultOpen={false}>
          <div className="space-y-1.5">
            <p className="text-xs text-muted">{t("photos.sources")}</p>
            <div className="flex flex-wrap gap-2">
              {TURZX_BG_SOURCES.map((src) => {
                const active = s.photoSources.includes(src);
                return (
                  <button key={src} type="button" onClick={() => toggleSource(src)} aria-pressed={active} title={sources(`${src}.description`)}
                    className={cn("min-h-6 rounded-full border px-3 py-1 text-xs transition", FOCUS, active ? "border-primary bg-primary/15 text-fg" : "border-border text-muted")}>
                    {sources(`${src}.label`)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("photos.interval", { sec: s.photoSec })}>
              <Slider value={s.photoSec} min={10} max={300} step={5} onChange={(n) => setS((p) => ({ ...p, photoSec: n }))} />
            </Field>
            <Field label={t("photos.dim", { pct: pct(s.dim) })}>
              <Slider value={s.dim} min={0} max={0.9} step={0.05} onChange={(n) => setS((p) => ({ ...p, dim: n }))} />
            </Field>
          </div>
          <Field label={t("photos.accent")}>
            <div className="flex flex-wrap items-center gap-2">
              {DEVICE_ACCENTS.map((c) => {
                const on = s.accent.toLowerCase() === c.hex;
                const label = t(`photos.accents.${c.id}`);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-label={t("photos.accentSwatch", { color: label })}
                    title={label}
                    aria-pressed={on}
                    onClick={() => setS((p) => ({ ...p, accent: c.hex }))}
                    // selected = border + scale; keyboard focus = separate outline
                    className={cn("size-7 shrink-0 rounded-full border-2 transition", FOCUS, on ? "scale-110 border-fg" : "border-transparent")}
                    style={{ background: c.css }}
                  />
                );
              })}
              <Input type="color" value={s.accent} onChange={(e) => setS((p) => ({ ...p, accent: e.target.value }))} className="h-8 w-12 shrink-0 p-1" aria-label={t("photos.accentCustom")} />
            </div>
          </Field>
        </Subsection>

        <Subsection title={t("behavior.title")} collapsible defaultOpen={false}>
          <Field label={t("behavior.idleAfter", { sec: s.idleAfterSec })}>
            <Slider value={s.idleAfterSec} min={10} max={300} step={5} onChange={(n) => setS((p) => ({ ...p, idleAfterSec: n }))} />
          </Field>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("behavior.nightFrom")}>
              <Input type="time" value={s.nightFrom} onChange={(e) => setS((p) => ({ ...p, nightFrom: e.target.value }))} />
            </Field>
            <Field label={t("behavior.nightTo")}>
              <Input type="time" value={s.nightTo} onChange={(e) => setS((p) => ({ ...p, nightTo: e.target.value }))} />
            </Field>
            <Field label={t("behavior.nightDim", { pct: pct(s.nightDim) })}>
              <Slider value={s.nightDim} min={0.05} max={1} step={0.05} onChange={(n) => setS((p) => ({ ...p, nightDim: n }))} />
            </Field>
            <Field label={t("behavior.castDevice")}>
              <Input value={s.cast.device} onChange={(e) => setS((p) => ({ ...p, cast: { ...p.cast, device: e.target.value } }))} />
            </Field>
          </div>
          <Field inline label={t("behavior.keepAlive")} hint={t("behavior.keepAliveHint")}>
            <Switch checked={s.cast.keepAlive} onCheckedChange={(on) => setS((p) => ({ ...p, cast: { ...p.cast, keepAlive: on } }))} />
          </Field>
          <Field inline label={t("behavior.respectPlayback")}>
            <Switch checked={s.cast.respectPlayback} onCheckedChange={(on) => setS((p) => ({ ...p, cast: { ...p.cast, respectPlayback: on } }))} />
          </Field>
          <Field inline label={t("behavior.tapFeedback")} hint={t("behavior.tapFeedbackHint")}>
            <Switch
              checked={(s as DisplaySettings & { tapFeedback?: boolean }).tapFeedback === true}
              onCheckedChange={(on) => setS((p) => ({ ...p, tapFeedback: on }))}
              aria-label={t("behavior.tapFeedback")}
            />
          </Field>
        </Subsection>
      </div>
    </SettingsPanel>
  );
}
