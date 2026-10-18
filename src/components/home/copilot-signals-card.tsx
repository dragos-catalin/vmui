"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SettingsPanel, Subsection } from "@/components/ui/settings-panel";
import { Switch } from "@/components/ui/switch";
import { COPILOT_EVENTS, type CopilotEvent, type CopilotSignals } from "@/lib/copilot/signals-schema";
import { cn } from "@/lib/utils";
import { saveCopilotSignalsAction, testCopilotSignalAction } from "@/server/actions/home";
import { Bot, Lightbulb, MonitorSmartphone, Play, Radio, Smartphone, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useHomeAction } from "./use-home-action";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const TARGETS = [
  { key: "light", Icon: Lightbulb },
  { key: "strip", Icon: Sparkles },
  { key: "turzx", Icon: MonitorSmartphone },
  { key: "esp", Icon: Radio },
  { key: "phone", Icon: Smartphone },
] as const;

/** Physical signals for agent-harness events: room bulbs, turzx card, ESP32.
 *  Fired by ~/.copilot/hooks -> POST /api/copilot/event. */
export function CopilotSignalsCard({ initial, lights, defaultOpen = false }: { initial: CopilotSignals; lights: Array<{ id: string; name: string }>; defaultOpen?: boolean }) {
  const t = useTranslations("devices.copilot");
  const [s, setS] = React.useState<CopilotSignals>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const eventName = (e: CopilotEvent) => t(`event.${e}.label`);
  const saveAction = useHomeAction(saveCopilotSignalsAction, { success: t("saved"), error: t("failed"), refresh: true });
  const testAction = useHomeAction(testCopilotSignalAction, { error: t("failed") });

  const setPattern = (e: CopilotEvent, patch: Partial<CopilotSignals["patterns"][CopilotEvent]>) =>
    setS((p) => ({ ...p, patterns: { ...p.patterns, [e]: { ...p.patterns[e], ...patch } } }));

  const save = async () => {
    setBusy("save");
    await saveAction.run(s);
    setBusy(null);
  };
  const test = async (e: CopilotEvent) => {
    if (dirty) {
      toast.error(t("saveFirst"));
      return;
    }
    setBusy(e);
    const r = await testAction.run(e);
    setBusy(null);
    if (r.ok) toast.success(t("sent", { name: eventName(e) }));
  };

  const activeEvents = COPILOT_EVENTS.filter((e) => s.patterns[e].enabled).length;
  return (
    <SettingsPanel
      id="copilot-signals"
      defaultOpen={defaultOpen}
      icon={<Bot aria-hidden />}
      title={t("title")}
      summary={s.enabled ? t("summary", { events: activeEvents, lights: s.lights.length, from: s.quietFrom, to: s.quietTo }) : t("summaryOff")}
      action={
        <div className="flex items-center gap-3">
          <Switch checked={s.enabled} onCheckedChange={(on) => setS((p) => ({ ...p, enabled: on }))} aria-label={t("enabledAria")} />
          <Button size="sm" onClick={save} disabled={!dirty || busy === "save"}>{busy === "save" ? t("saving") : t("save")}</Button>
        </div>
      }
    >
    <div className="space-y-5">
      <p className="text-xs leading-snug text-muted">{t("intro")}</p>
      <Subsection title={<span className="inline-flex items-center gap-2"><Lightbulb className="size-3.5" aria-hidden /> {t("lightsTitle")}</span>}>
        {lights.length === 0 && <p className="text-sm text-muted">{t("noLights")}</p>}
        <ul className="flex flex-wrap gap-2">
          {lights.map((l) => {
            const on = s.lights.includes(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setS((p) => ({ ...p, lights: on ? p.lights.filter((x) => x !== l.id) : [...p.lights, l.id] }))}
                  aria-pressed={on}
                  title={l.name}
                  className={cn("max-w-full rounded-full border px-3 py-1 text-left text-sm transition [overflow-wrap:anywhere]", FOCUS, on ? "border-primary bg-primary/15 text-fg" : "border-border text-muted hover:text-fg")}
                >
                  {l.name}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <Field label={<span className="inline-flex items-center gap-1.5"><Smartphone className="size-3.5" aria-hidden /> {t("phoneNotify")}</span>} className="sm:col-span-2">
            <Input value={s.phoneNotify} onChange={(e) => setS((p) => ({ ...p, phoneNotify: e.target.value }))} placeholder={t("phoneNotifyPlaceholder")} className="font-mono text-xs" aria-label={t("phoneNotifyAria")} />
          </Field>
          <Field inline label={t("muteInMovie")} className="sm:col-span-2">
            <Switch checked={s.muteInMovie} onCheckedChange={(on) => setS((p) => ({ ...p, muteInMovie: on }))} aria-label={t("muteInMovieAria")} />
          </Field>
          <Field label={t("quietFrom")}>
            <Input type="time" value={s.quietFrom} onChange={(e) => setS((p) => ({ ...p, quietFrom: e.target.value }))} aria-label={t("quietFrom")} />
          </Field>
          <Field label={t("quietTo")}>
            <Input type="time" value={s.quietTo} onChange={(e) => setS((p) => ({ ...p, quietTo: e.target.value }))} aria-label={t("quietTo")} />
          </Field>
        </div>
      </Subsection>

      <Subsection title={t("eventsTitle")} hint={t("eventsHint")}>
        <ul className="space-y-3">
          {COPILOT_EVENTS.map((e) => {
            const p = s.patterns[e];
            const name = eventName(e);
            return (
              <li key={e} className={cn("space-y-3 rounded-xl border p-3", p.enabled ? "border-primary/40 bg-primary/5" : "border-border opacity-70")}>
                <Field
                  inline
                  className="border-0 px-0 py-0"
                  label={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">{name} <Badge variant="muted">{e}</Badge></span>}
                  hint={<span className="text-xs leading-snug text-muted">{t(`event.${e}.hint`)}</span>}
                >
                  <Switch checked={p.enabled} onCheckedChange={(on) => setPattern(e, { enabled: on })} aria-label={t("activeAria", { name })} />
                </Field>
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <Field label={t("targetsLabel")}>
                    <div className="flex flex-wrap gap-1" role="group" aria-label={t("targetsAria", { name })}>
                      {TARGETS.map(({ key, Icon }) => (
                        <Target key={key} on={p[key]} onChange={(v) => setPattern(e, { [key]: v })} label={t(`target.${key}`)}>
                          <Icon className="size-3.5" aria-hidden />
                        </Target>
                      ))}
                    </div>
                  </Field>
                  <Field label={t("colorLabel")}>
                    <div className="flex items-center gap-2">
                      <input type="color" value={p.color} onChange={(ev) => setPattern(e, { color: ev.target.value })} aria-label={t("colorAria", { name })} className={cn("size-9 shrink-0 rounded-md border border-border-strong bg-transparent p-0.5", FOCUS)} />
                      <Button size="sm" variant="outline" onClick={() => test(e)} disabled={busy !== null || !p.enabled} aria-label={t("testAria", { name })}>
                        <Play className="size-3.5" aria-hidden /> {t("test")}
                      </Button>
                    </div>
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>
      </Subsection>
    </div>
    </SettingsPanel>
  );
}

function Target({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={label}
      aria-label={label}
      className={cn("inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs transition", FOCUS, on ? "border-primary bg-primary/15 text-fg" : "border-border text-muted hover:text-fg")}
    >
      {children}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}
