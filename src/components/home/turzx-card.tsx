"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, SettingsPanel, Subsection } from "@/components/ui/settings-panel";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useInterval, useInView } from "@/hooks/use-poll";
import { NOTIFY_APPS, TURZX_BG_SOURCES, TURZX_SKINS, TURZX_VIEW_META, type OptionField, type TurzxBgSource, type TurzxSkin, type TurzxViewId } from "@/lib/turzx/catalog";
import type { Pomodoro, TurzxBackground, TurzxSettings, TurzxViewConfig } from "@/lib/turzx/settings";
import { cn } from "@/lib/utils";
import { pomodoroAction, saveTurzxSettingsAction } from "@/server/actions/home";
import { ArrowDown, ArrowUp, BellRing, ChevronDown, ChevronUp, Coffee, Image as ImageIcon, MonitorSmartphone, Play, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { DEVICE_ACCENTS } from "./accent-swatches";
import { useHomeAction } from "./use-home-action";

const MIN_DWELL = 5;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const CHIP = `min-h-6 rounded-lg border px-2.5 py-1 text-xs transition ${FOCUS}`;
const CHIP_ON = "border-primary bg-primary/15 text-fg";
const CHIP_OFF = "border-border text-muted hover:text-fg";
const MIRROR_MS = 2500;

/** Label above a group of toggle buttons. A `<label>` would forward clicks to the first chip, so this is a plain block. */
function Group({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div role="group" className={cn("min-w-0 space-y-1.5", className)}>
      <p className="text-xs text-muted">{label}</p>
      {children}
      {hint && <p className="text-xs leading-snug text-muted">{hint}</p>}
    </div>
  );
}

/** View manager for the 3.5" Turzx desk screen driven by turzx/turzx.py. */
/** What the panel shows right now: the renderer writes its last pushed frame
 *  once a second, /api/turzx/mirror serves it. Refreshes every 2.5 s, only
 *  while the card is on screen and the browser tab is visible. */
function LiveMirror() {
  const t = useTranslations("turzx");
  const [ref, inView] = useInView<HTMLDivElement>();
  const [tick, setTick] = React.useState(() => Date.now());
  const [ok, setOk] = React.useState(true);
  const [big, setBig] = React.useState(false);
  const fails = React.useRef(0);
  useInterval(
    () => {
      setTick(Date.now());
      // after a failure, retry every 4th tick (~10 s)
      if (!ok && ++fails.current % 4 === 0) setOk(true);
    },
    inView ? MIRROR_MS : null,
  );
  return (
    <Subsection
      title={t("mirror.title")}
      className="space-y-3"
      action={
        <button type="button" className={cn("min-h-6 rounded-md px-1.5 py-0.5 text-xs text-primary-text hover:bg-bg-muted", FOCUS)} onClick={() => setBig((b) => !b)} aria-pressed={big}>
          {big ? t("mirror.zoomOut") : t("mirror.zoomIn")}
        </button>
      }
    >
      <div ref={ref}>
        {ok ? (
          // eslint-disable-next-line @next/next/no-img-element -- dynamic PNG, no optimisation wanted
          <img
            src={`/api/turzx/mirror?t=${tick}`}
            alt={t("mirror.alt")}
            width={big ? 960 : 480}
            height={big ? 640 : 320}
            className="h-auto max-w-full rounded-lg border border-border bg-bg-muted"
            style={{ imageRendering: big ? "pixelated" : "auto" }}
            onError={() => setOk(false)}
            onLoad={() => {
              fails.current = 0;
              setOk(true);
            }}
          />
        ) : (
          <p className="break-words text-sm text-muted">{t("mirror.offline")}</p>
        )}
      </div>
    </Subsection>
  );
}

export function TurzxCard({ initial, pomodoro, defaultOpen = false }: { initial: TurzxSettings; pomodoro: Pomodoro; defaultOpen?: boolean }) {
  const t = useTranslations("turzx");
  const [s, setS] = React.useState<TurzxSettings>(initial);
  const [open, setOpen] = React.useState<string | null>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const saveAction = useHomeAction(saveTurzxSettingsAction, { success: t("saved"), error: t("saveFailed"), refresh: true });
  const busy = saveAction.pending;
  const setNotify = (patch: Partial<TurzxSettings["notify"]>) => setS((p) => ({ ...p, notify: { ...p.notify, ...patch } }));

  const setView = (id: string, patch: Partial<TurzxViewConfig>) => setS((p) => ({ ...p, views: p.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));
  const move = (id: string, dir: -1 | 1) =>
    setS((p) => {
      const i = p.views.findIndex((v) => v.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.views.length) return p;
      const next = [...p.views];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...p, views: next };
    });

  const save = () => void saveAction.run(s);

  const enabledCount = s.views.filter((v) => v.enabled).length;
  const cycleSec = s.views.filter((v) => v.enabled).reduce((a, v) => a + v.dwellSec, 0);

  return (
    <SettingsPanel
      id="turzx"
      icon={<MonitorSmartphone aria-hidden />}
      title={t("title")}
      summary={t("summary", { n: enabledCount, min: Math.floor(cycleSec / 60), sec: cycleSec % 60 })}
      defaultOpen={defaultOpen}
      action={<Button size="sm" onClick={save} disabled={!dirty || busy}>{busy ? t("saving") : t("save")}</Button>}
    >
      <div className="space-y-4">
        <PomodoroBar p={pomodoro} />
        <LiveMirror />

        <Subsection title={t("views.title")} hint={t("views.hint")}>
          <ul className="space-y-2">
            {s.views.map((v, i) => {
              const meta = TURZX_VIEW_META[v.id];
              const name = t(`views.${v.id}.label`);
              const isOpen = open === v.id;
              return (
                <li key={v.id} className={cn("rounded-xl border transition", v.enabled ? "border-primary/40 bg-primary/5" : "border-border opacity-70")}>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
                    <Switch checked={v.enabled} onCheckedChange={(on) => setView(v.id, { enabled: on })} aria-label={t("views.enabled", { name })} className="shrink-0" />
                    <button type="button" className={cn("min-w-0 rounded-md text-left", FOCUS)} title={name} onClick={() => setOpen(isOpen ? null : v.id)} aria-expanded={isOpen}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm font-medium leading-tight">{name}</span>
                        {v.background?.mode === "photo" && <ImageIcon className="size-3.5 shrink-0 text-muted" aria-label={t("views.ownPhotoBg")} />}
                      </span>
                      <span className="block truncate text-xs leading-snug text-muted">
                        {v.dwellSec} s · {t(`skins.${v.skin}.label`)}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button size="icon" variant="ghost" className="shrink-0" aria-label={t("views.moveUp", { name })} onClick={() => move(v.id, -1)} disabled={i === 0}><ArrowUp className="size-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" className="shrink-0" aria-label={t("views.moveDown", { name })} onClick={() => move(v.id, 1)} disabled={i === s.views.length - 1}><ArrowDown className="size-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" className="shrink-0" onClick={() => setOpen(isOpen ? null : v.id)} aria-label={isOpen ? t("views.collapse") : t("views.configure")} aria-expanded={isOpen}>
                        {isOpen ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
                      </Button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="space-y-3 border-t border-border px-3 py-3">
                      <p className="text-xs leading-snug text-muted break-words">{t(`views.${v.id}.description`)}</p>
                      <div className="grid items-start gap-3 sm:grid-cols-2">
                        <Field label={t("views.dwell", { n: v.dwellSec })}>
                          <Slider min={MIN_DWELL} max={120} step={1} value={v.dwellSec} onChange={(n) => setView(v.id, { dwellSec: n })} aria-label={t("views.dwellAria")} />
                        </Field>
                        <Group label={t("views.skin")}>
                          <SkinPicker value={v.skin} allowed={meta.skins} onChange={(skin) => setView(v.id, { skin })} />
                        </Group>
                      </div>
                      <Field inline label={t("views.ownBackground")} hint={v.background ? t("views.ownBackgroundOn") : t("views.ownBackgroundOff")}>
                        <Switch checked={v.background !== null} onCheckedChange={(on) => setView(v.id, { background: on ? { ...s.background } : null })} aria-label={t("views.ownBackground")} />
                      </Field>
                      {v.background && <BackgroundEditor value={v.background} onChange={(background) => setView(v.id, { background })} />}
                      {meta.options.length > 0 && (
                        <div className="grid items-start gap-3 sm:grid-cols-2">
                          {meta.options.map((f) => (
                            <OptionInput key={f.key} view={v.id} field={f} value={v.options[f.key]} onChange={(val) => setView(v.id, { options: { ...v.options, [f.key]: val } })} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Subsection>

        <Subsection
          title={<span className="inline-flex items-center gap-2"><BellRing className="size-3.5 text-primary-text" aria-hidden /> {t("notify.title")}</span>}
          hint={t("notify.hint")}
          collapsible
          defaultOpen={false}
        >
          {/* HM-36: the master switch lives in the body, not inside <summary> (no nested interactive). */}
          <Field inline label={t("notify.enabled")}>
            <Switch checked={s.notify.enabled} onCheckedChange={(v) => setNotify({ enabled: v })} aria-label={t("notify.enabled")} />
          </Field>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field inline label={t("notify.presenceOnly")} hint={t("notify.presenceOnlyHint")}>
              <Switch checked={s.notify.presenceOnly} onCheckedChange={(v) => setNotify({ presenceOnly: v })} aria-label={t("notify.presenceOnlyAria")} />
            </Field>
            <Field inline label={t("notify.showText")} hint={s.notify.showText ? t("notify.showTextHintOn") : t("notify.showTextHintOff")}>
              <Switch checked={s.notify.showText} onCheckedChange={(v) => setNotify({ showText: v })} aria-label={t("notify.showText")} />
            </Field>
            <Group label={t("notify.position")}>
              <div className="flex flex-wrap gap-1.5">
                {(["top", "center", "bottom"] as const).map((p) => (
                  <button key={p} type="button" aria-pressed={s.notify.position === p} onClick={() => setNotify({ position: p })} className={cn(CHIP, s.notify.position === p ? CHIP_ON : CHIP_OFF)}>
                    {p === "top" ? t("notify.positionTop") : p === "center" ? t("notify.positionCenter") : t("notify.positionBottom")}
                  </button>
                ))}
              </div>
            </Group>
            <Field label={t("notify.duration", { n: s.notify.durationSec })}>
              <Slider min={2} max={30} step={1} value={s.notify.durationSec} onChange={(n) => setNotify({ durationSec: n })} aria-label={t("notify.durationAria")} />
            </Field>
          </div>
          <Group label={t("notify.apps")} hint={t("notify.appsHint")}>
            <div className="flex flex-wrap gap-1.5">
              {NOTIFY_APPS.map((a) => {
                const on = s.notify.packages.includes(a.pkg);
                return (
                  <button key={a.pkg} type="button" aria-pressed={on} onClick={() => setNotify({ packages: on ? s.notify.packages.filter((p) => p !== a.pkg) : [...s.notify.packages, a.pkg] })} className={cn(CHIP, "flex items-center gap-1.5", on ? CHIP_ON : CHIP_OFF)}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} aria-hidden />
                    {a.label}
                  </button>
                );
              })}
            </div>
          </Group>
          <Field label={t("notify.otherPackages")}>
            <Textarea
              value={s.notify.packages.filter((p) => !NOTIFY_APPS.some((a) => a.pkg === p)).join("\n")}
              onChange={(e) => setNotify({ packages: [...s.notify.packages.filter((p) => NOTIFY_APPS.some((a) => a.pkg === p)), ...e.target.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean)] })}
              placeholder={t("notify.otherPackagesPlaceholder")}
              rows={2}
              aria-label={t("notify.otherPackages")}
            />
          </Field>
        </Subsection>

        <Subsection title={t("background.title")} hint={t("background.hint")} collapsible defaultOpen={false}>
          <BackgroundEditor value={s.background} onChange={(background) => setS({ ...s, background })} />
          <Field label={t("background.rotate", { n: s.bgRotateMin })}>
            <Slider min={1} max={240} step={1} value={s.bgRotateMin} onChange={(n) => setS({ ...s, bgRotateMin: n })} aria-label={t("background.rotateAria")} />
          </Field>
        </Subsection>

        <Subsection title={t("screen.title")} collapsible defaultOpen={false}>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("screen.fps", { n: s.fps })}>
              <Slider min={5} max={30} step={1} value={s.fps} onChange={(n) => setS({ ...s, fps: n })} aria-label={t("screen.fpsAria")} />
            </Field>
            <Field label={t("screen.transition", { n: s.transitionMs })}>
              <Slider min={0} max={1500} step={50} value={s.transitionMs} onChange={(n) => setS({ ...s, transitionMs: n })} aria-label={t("screen.transitionAria")} />
            </Field>
            <Field label={t("screen.brightness", { n: s.brightness })}>
              <Slider min={5} max={100} step={5} value={s.brightness} onChange={(n) => setS({ ...s, brightness: n })} aria-label={t("screen.brightnessAria")} />
            </Field>
            <Field label={t("screen.nightBrightness", { n: s.nightBrightness })}>
              <Slider min={0} max={100} step={5} value={s.nightBrightness} onChange={(n) => setS({ ...s, nightBrightness: n })} aria-label={t("screen.nightBrightnessAria")} />
            </Field>
            <Group label={t("screen.nightRange")}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-sm">
                <Input type="time" value={s.nightFrom} onChange={(e) => setS({ ...s, nightFrom: e.target.value })} aria-label={t("screen.nightFrom")} />
                <span className="text-muted" aria-hidden>→</span>
                <Input type="time" value={s.nightTo} onChange={(e) => setS({ ...s, nightTo: e.target.value })} aria-label={t("screen.nightTo")} />
              </div>
            </Group>
            <Field inline label={t("screen.orientation")} hint={s.flip ? t("screen.flipped") : t("screen.normal")} className="self-end">
              <Switch checked={s.flip} onCheckedChange={(v) => setS({ ...s, flip: v })} aria-label={t("screen.flipAria")} />
            </Field>
            <Group label={t("screen.accent")} className="sm:col-span-2">
              <div className="flex flex-wrap gap-2">
                {DEVICE_ACCENTS.map((c) => {
                  const on = s.accent.toLowerCase() === c.hex;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-label={t("screen.accentAria", { color: t(`accents.${c.id}`) })}
                      title={t(`accents.${c.id}`)}
                      aria-pressed={on}
                      onClick={() => setS({ ...s, accent: c.hex })}
                      // selected = inner ring; keyboard focus = separate outline
                      className={cn("size-8 shrink-0 rounded-full border-2 transition", FOCUS, on ? "border-fg" : "border-transparent")}
                      style={{ background: c.css }}
                    />
                  );
                })}
                <input type="color" value={s.accent} onChange={(e) => setS({ ...s, accent: e.target.value })} aria-label={t("screen.customAccent")} className={cn("size-8 shrink-0 rounded-full border-0 bg-transparent", FOCUS)} />
              </div>
            </Group>
          </div>
        </Subsection>
      </div>
    </SettingsPanel>
  );
}

function SkinPicker({ value, allowed, onChange }: { value: TurzxSkin; allowed: TurzxSkin[]; onChange: (s: TurzxSkin) => void }) {
  const t = useTranslations("turzx");
  return (
    <div className="flex flex-wrap gap-1.5">
      {TURZX_SKINS.filter((k) => allowed.includes(k)).map((k) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)} title={t(`skins.${k}.description`)} className={cn(CHIP, value === k ? CHIP_ON : CHIP_OFF)}>
          {t(`skins.${k}.label`)}
        </button>
      ))}
    </div>
  );
}

function BackgroundEditor({ value, onChange }: { value: TurzxBackground; onChange: (b: TurzxBackground) => void }) {
  const t = useTranslations("turzx");
  const toggleSrc = (src: TurzxBgSource) => onChange({ ...value, sources: value.sources.includes(src) ? value.sources.filter((x) => x !== src) : [...value.sources, src] });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {(["none", "photo"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={value.mode === m} onClick={() => onChange({ ...value, mode: m })} className={cn(CHIP, value.mode === m ? CHIP_ON : CHIP_OFF)}>
            {m === "none" ? t("background.modeNone") : t("background.modePhoto")}
          </button>
        ))}
      </div>
      {value.mode === "photo" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {TURZX_BG_SOURCES.map((src) => (
              <button key={src} type="button" aria-pressed={value.sources.includes(src)} onClick={() => toggleSrc(src)} title={t(`sources.${src}.description`)} className={cn(CHIP, value.sources.includes(src) ? CHIP_ON : CHIP_OFF)}>
                {t(`sources.${src}.label`)}
              </button>
            ))}
          </div>
          {value.sources.includes("folder") && (
            <Field label={t("background.folder")}>
              <Input value={value.folder} onChange={(e) => onChange({ ...value, folder: e.target.value })} placeholder={t("background.folderPlaceholder")} />
            </Field>
          )}
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("background.dim", { n: Math.round(value.dim * 100) })}>
              <Slider min={0} max={90} step={5} value={Math.round(value.dim * 100)} onChange={(n) => onChange({ ...value, dim: n / 100 })} aria-label={t("background.dimAria")} />
            </Field>
            <Field label={t("background.blur", { n: value.blur })}>
              <Slider min={0} max={12} step={1} value={value.blur} onChange={(n) => onChange({ ...value, blur: n })} aria-label={t("background.blurAria")} />
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

function OptionInput({ view, field, value, onChange }: { view: TurzxViewId; field: OptionField; value: unknown; onChange: (v: unknown) => void }) {
  // option keys are data-driven (view × field), too wide for the typed key union → checked at runtime with has()
  const t = useTranslations("turzx") as unknown as { (k: string): string; has(k: string): boolean };
  const p = `options.${view}.${field.key}`;
  const label = t(`${p}.label`);
  const hint = t.has(`${p}.hint`) ? t(`${p}.hint`) : undefined;
  const placeholder = t.has(`${p}.placeholder`) ? t(`${p}.placeholder`) : undefined;
  switch (field.type) {
    case "toggle":
      return (
        <Field inline label={label}>
          <Switch checked={value === undefined ? Boolean(field.default) : Boolean(value)} onCheckedChange={onChange} aria-label={label} />
        </Field>
      );
    case "number":
      return (
        <Field label={`${label} · ${typeof value === "number" ? value : "—"}`}>
          <Slider min={field.min} max={field.max} step={field.step ?? 1} value={typeof value === "number" ? value : field.min} onChange={onChange} aria-label={label} />
        </Field>
      );
    case "select":
      return (
        <Field label={label}>
          <Select value={typeof value === "string" ? value : field.choices[0]} onValueChange={onChange}>
            <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
            <SelectContent>
              {field.choices.map((c) => <SelectItem key={c} value={c}>{t(`${p}.choice_${c}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      );
    case "list":
      return (
        <Field label={label} hint={hint}>
          <Textarea
            value={Array.isArray(value) ? value.join("\n") : ""}
            onChange={(e) => onChange(e.target.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean))}
            placeholder={placeholder}
            rows={3}
            aria-label={label}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={hint}>
          <Input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
        </Field>
      );
  }
}

function PomodoroBar({ p }: { p: Pomodoro }) {
  const t = useTranslations("turzx");
  const [, tick] = React.useState(0);
  useInterval(() => tick((n) => n + 1), p.phase === "idle" ? null : 1000);
  const action = useHomeAction(pomodoroAction, { error: t("saveFailed"), refresh: true });
  const busy = action.pending;
  const left = Math.max(0, p.endsAt - Date.now());
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  const act = (cmd: "start" | "break" | "stop") => void action.run(cmd);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <Coffee className="size-5 shrink-0 text-primary-text" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {t("pomodoro.title")} {p.phase !== "idle" && <span className="font-normal text-muted">{t("pomodoro.round", { n: p.round })}</span>}
          </p>
          <p className="text-xs leading-snug text-muted break-words">
            {p.phase === "idle"
              ? t("pomodoro.idle")
              : t("pomodoro.remaining", { phase: p.phase === "work" ? t("pomodoro.work") : t("pomodoro.break"), time: `${mm}:${String(ss).padStart(2, "0")}` })}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {p.phase !== "work" && <Button size="sm" onClick={() => act("start")} disabled={busy}><Play className="size-3.5" aria-hidden /> {t("pomodoro.startWork")}</Button>}
        {p.phase === "work" && <Button size="sm" variant="secondary" onClick={() => act("break")} disabled={busy}><Coffee className="size-3.5" aria-hidden /> {t("pomodoro.startBreak")}</Button>}
        {p.phase !== "idle" && <Button size="sm" variant="ghost" onClick={() => act("stop")} disabled={busy}><Square className="size-3.5" aria-hidden /> {t("pomodoro.stop")}</Button>}
      </div>
    </div>
  );
}
