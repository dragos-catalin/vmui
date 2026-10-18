"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, SettingsPanel } from "@/components/ui/settings-panel";
import { GESTURES, type ButtonAction, type ButtonBindings, type Gesture } from "@/lib/home/button-bindings-schema";
import { saveButtonBindingsAction, testButtonGestureAction } from "@/server/actions/button-bindings";
import { CirclePlay, MousePointerClick, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useHomeAction } from "./use-home-action";

type Kind = ButtonAction["type"];
const KINDS = ["none", "water_add", "water_undo", "ha_script", "ha_service", "intercom_open", "intercom_arm", "turzx_next", "turzx_pause", "ambilight_movie", "pc_wake"] as const satisfies readonly Kind[];

function defaultFor(kind: Kind): ButtonAction {
  switch (kind) {
    case "water_add": return { type: kind, ml: 250 };
    case "ha_script": return { type: kind, script: "" };
    case "ha_service": return { type: kind, service: "light.toggle", entityId: "" };
    case "intercom_arm": return { type: kind, minutes: 45 };
    default: return { type: kind } as ButtonAction;
  }
}

/** Gesture → action table for the desk button (Pi GPIO). Same store drives
 *  `POST /api/esp/button?btn=desk`, so what you save here is what the button does. */
export function ButtonBindingsCard({ initial, scripts, defaultOpen = false }: { initial: ButtonBindings; scripts: string[]; defaultOpen?: boolean }) {
  const t = useTranslations("devices.buttons");
  const [b, setB] = React.useState<ButtonBindings>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const saveAction = useHomeAction(saveButtonBindingsAction, { success: t("saved"), refresh: true });
  const testAction = useHomeAction(testButtonGestureAction, { success: t("testSent") });
  const dirty = JSON.stringify(b) !== JSON.stringify(initial);
  const gestureName = (g: Gesture) => t(`gesture.${g}`);
  const kindName = (k: Kind) => t(`kind.${k}`);

  const set = (g: Gesture, a: ButtonAction) => setB((s) => ({ ...s, gestures: { ...s.gestures, [g]: a } }));

  const save = async () => {
    setBusy("save");
    const clean: ButtonBindings = { ...b, gestures: { ...b.gestures } };
    for (const g of GESTURES) {
      const a = clean.gestures[g] ?? { type: "none" };
      if (a.type === "ha_service" && !a.entityId) clean.gestures[g] = { type: "ha_service", service: a.service };
    }
    await saveAction.run(clean);
    setBusy(null);
  };
  const test = async (g: Gesture) => {
    setBusy(g);
    await testAction.run(g);
    setBusy(null);
  };

  const bound = GESTURES.filter((g) => (b.gestures[g]?.type ?? "none") !== "none");
  return (
    <SettingsPanel
      id="desk-button"
      defaultOpen={defaultOpen}
      icon={<MousePointerClick aria-hidden />}
      title={t("title")}
      summary={bound.length ? bound.map((g) => t("summaryItem", { gesture: gestureName(g), kind: kindName(b.gestures[g]?.type ?? "none") })).join(" · ") : t("summaryEmpty")}
      action={
        <Button size="sm" onClick={save} disabled={!dirty || busy !== null}>
          <Save className="size-4" aria-hidden /> {t("save")}
        </Button>
      }
    >
      <p className="mb-3 text-xs leading-snug text-muted">{t("intro")}</p>
      <ul className="divide-y divide-[var(--color-border)]">
        {GESTURES.map((g) => {
          const a: ButtonAction = b.gestures[g] ?? { type: "none" };
          const name = gestureName(g);
          return (
            <li key={g} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-3 sm:grid-cols-[minmax(8rem,11rem)_minmax(0,1fr)_auto]">
              <span className="min-w-0 pt-2 text-sm font-semibold [overflow-wrap:anywhere]" title={name}>{name}</span>
              <Button variant="ghost" size="sm" className="sm:order-3" disabled={busy !== null || a.type === "none"} onClick={() => test(g)} aria-label={t("testAria", { gesture: name })}>
                <CirclePlay className="size-4" aria-hidden /> {t("test")}
              </Button>
              <div className="col-span-2 min-w-0 space-y-2 sm:order-2 sm:col-span-1">
                <Field label={t("actionLabel")} hint={t(`hint.${a.type}`)}>
                  <div className="flex min-w-0 gap-2">
                    <Select value={a.type} onValueChange={(v) => set(g, defaultFor(v as Kind))}>
                      <SelectTrigger className="min-w-0 flex-1" aria-label={t("actionAria", { gesture: name })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((k) => (
                          <SelectItem key={k} value={k} className="truncate">{kindName(k)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {a.type === "water_add" && (
                      <Input type="number" min={10} max={2000} step={10} className="w-24 shrink-0" value={a.ml} aria-label={t("mlAria")} onChange={(e) => set(g, { type: "water_add", ml: Number(e.target.value) || 0 })} />
                    )}
                    {a.type === "intercom_arm" && (
                      <Input type="number" min={1} max={240} className="w-24 shrink-0" value={a.minutes} aria-label={t("minutesAria")} onChange={(e) => set(g, { type: "intercom_arm", minutes: Number(e.target.value) || 1 })} />
                    )}
                  </div>
                </Field>
                {a.type === "ha_script" && (
                  <Select value={a.script} onValueChange={(v) => set(g, { type: "ha_script", script: v })}>
                    <SelectTrigger className="min-w-0" aria-label={t("scriptAria")}><SelectValue placeholder={t("scriptPlaceholder")} /></SelectTrigger>
                    <SelectContent>
                      {scripts.map((s) => <SelectItem key={s} value={s} className="truncate">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {a.type === "ha_service" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input className="min-w-0" placeholder={t("servicePlaceholder")} value={a.service} aria-label={t("serviceAria")} onChange={(e) => set(g, { ...a, service: e.target.value })} />
                    <Input className="min-w-0" placeholder={t("entityPlaceholder")} value={a.entityId ?? ""} aria-label={t("entityAria")} onChange={(e) => set(g, { ...a, entityId: e.target.value })} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </SettingsPanel>
  );
}
