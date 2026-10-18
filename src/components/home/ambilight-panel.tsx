"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Panel, Subsection } from "@/components/ui/settings-panel";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { AMBIENT_EFFECTS, AMBILIGHT_MODES, HYPERHDR_INSTANCES, MUSIC_EFFECTS, NOTIFY_PALETTE } from "@/lib/home/catalog";
import { cn } from "@/lib/utils";
import {
    clearHyperPriorityAction,
    notifyFlashAction,
    runHyperEffectAction,
    setAmbilightModeAction,
    setGrabberAction,
    setWallCompensationAction,
} from "@/server/actions/home";
import type { WallSetting } from "@/server/queries/home";
import { Bell, Clapperboard, Eraser, Lamp, MonitorPlay, Music2, Zap } from "lucide-react";
import { LayoutGroup } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { SPRING } from "./home-motion";
import { useHomeAction } from "./use-home-action";
import { useEntity, useHomeStates } from "./use-home-states";

const MODE_ICON = { movie: Clapperboard, music: Music2, off: Lamp } as const;
const MODE_GLOW = { movie: "var(--color-primary)", music: "var(--color-accent)", off: "var(--color-lit)" } as const;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

type EffectKey =
  | "musicStereo"
  | "musicStereoFast"
  | "musicQuatro"
  | "musicPulseWaves"
  | "musicFullscreenPulse"
  | "musicFullscreenPulseWhite"
  | "warmBlobs"
  | "coldBlobs"
  | "colorBlobs"
  | "seaWaves"
  | "rainbowSwirl"
  | "plasma"
  | "candle"
  | "breath";

const EFFECT_KEY: Record<(typeof MUSIC_EFFECTS)[number] | (typeof AMBIENT_EFFECTS)[number], EffectKey> = {
  "Music: stereo for LED strip (MULTI COLOR)": "musicStereo",
  "Music: stereo for LED strip (MULTI COLOR FAST)": "musicStereoFast",
  "Music: quatro for LED strip (MULTI COLOR)": "musicQuatro",
  "Music: pulse waves for LED strip (MULTI COLOR)": "musicPulseWaves",
  "Music: fullscreen pulse (MULTI COLOR)": "musicFullscreenPulse",
  "Music: fullscreen pulse (WHITE)": "musicFullscreenPulseWhite",
  "Warm mood blobs": "warmBlobs",
  "Cold mood blobs": "coldBlobs",
  "Full color mood blobs": "colorBlobs",
  "Sea waves": "seaWaves",
  "Rainbow swirl": "rainbowSwirl",
  Plasma: "plasma",
  Candle: "candle",
  Breath: "breath",
};

const NOTIFY_APP_KEY: Record<string, "whatsapp" | "phone" | "messages" | "gmail"> = {
  "com.whatsapp": "whatsapp",
  "com.samsung.android.dialer": "phone",
  "com.samsung.android.messaging": "messages",
  "com.google.android.gm": "gmail",
};

export function AmbilightPanel({ wall }: { wall: WallSetting }) {
  const t = useTranslations("ambilight");
  const [busy, setBusy] = React.useState<string | null>(null);
  const { live } = useHomeStates();
  const hyper = useEntity("light.hyperhdr");
  const lastNotif = useEntity("sensor.dragos_s_s25_ultra_last_notification");
  const status = ambilightStatus(hyper);
  // Start from what HyperHDR reports; a click wins until the next state frame says otherwise.
  const [mode, setMode] = React.useState<string | null>(null);
  const shownMode = mode ?? (status === "movie" ? "movie" : status === "music" ? "music" : null);
  // HM-07: the capture switch follows the live grabber state (movie = SYSTEMGRABBER owns the LEDs).
  const [grabber, setGrabber] = React.useState<boolean | null>(null);
  const grabberOn = grabber ?? status === "movie";
  React.useEffect(() => setGrabber(null), [status]);

  const action = useHomeAction(async (fn: () => Promise<{ ok: boolean; error?: string }>) => fn());
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) => {
    setBusy(key);
    const r = await action.run(fn);
    setBusy(null);
    if (r.ok && okMsg) toast.success(okMsg);
    return r.ok;
  };

  const effectButtons = (effects: readonly ((typeof MUSIC_EFFECTS)[number] | (typeof AMBIENT_EFFECTS)[number])[], Icon: React.ComponentType<{ className?: string }>) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {effects.map((e) => (
        <button
          key={e}
          type="button"
          disabled={busy !== null}
          title={t(`effects.${EFFECT_KEY[e]}`)}
          onClick={() => void act(e, () => runHyperEffectAction({ effect: e }))}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-primary disabled:opacity-50",
            FOCUS,
            busy === e && "border-primary",
          )}
        >
          <Icon className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate">{t(`effects.${EFFECT_KEY[e]}`)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <Panel
      id="ambilight"
      title={t("title")}
      description={t("description")}
      action={
        <>
          <Badge variant={live === "live" ? "success" : live === "connecting" ? "muted" : "warning"} dot>
            {t(`live.${live === "live" ? "live" : live === "connecting" ? "connecting" : "offline"}`)}
          </Badge>
          <Badge variant={status === "unreachable" ? "danger" : status === "movie" ? "success" : "info"}>{t("hyperhdr", { status: t(`status.${status}`) })}</Badge>
        </>
      }
    >
      <div className="space-y-5">
      <LayoutGroup id="ambilight-modes">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
          {AMBILIGHT_MODES.map((md) => {
            const Icon = MODE_ICON[md.id];
            const active = shownMode === md.id;
            const name = t(`modes.${md.id}.name`);
            const description = t(`modes.${md.id}.description`);
            return (
              <m.button
                key={md.id}
                type="button"
                whileTap={{ scale: 0.97 }}
                disabled={busy !== null}
                onClick={() => void act(md.id, () => setAmbilightModeAction(md.id), t("modeApplied", { name })).then((ok) => ok && setMode(md.id))}
                aria-pressed={active}
                title={`${name} — ${description}`}
                className={cn(
                  "group relative isolate flex min-w-0 items-center gap-3 overflow-clip rounded-lg border px-3 py-2.5 text-left transition-colors",
                  FOCUS,
                  active ? "border-primary" : "border-border bg-surface hover:border-[color-mix(in_oklch,var(--color-primary)_55%,var(--color-border))]",
                )}
              >
                {/* Active-mode backdrop slides between modes. */}
                {active && (
                  <m.span
                    layoutId="ambilight-active-mode"
                    aria-hidden
                    transition={SPRING}
                    className="absolute inset-0 -z-10 bg-[color-mix(in_oklch,var(--color-primary)_14%,var(--color-surface))]"
                  />
                )}
                <span
                  aria-hidden
                  className={cn("pointer-events-none absolute -right-6 -top-6 -z-10 size-20 rounded-full blur-2xl transition-opacity", active ? "opacity-70" : "opacity-0 group-hover:opacity-40")}
                  style={{ background: MODE_GLOW[md.id] }}
                />
                <Icon className={cn("size-4 shrink-0", active ? "text-primary-text" : "text-muted")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{name}</span>
                  <span className="line-clamp-2 block text-xs text-muted">{description}</span>
                </span>
                {busy === md.id && <span className="pulse-dot shrink-0" aria-hidden />}
              </m.button>
            );
          })}
        </div>
      </LayoutGroup>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <Field
          inline
          label={
            <span className="flex items-center gap-2">
              <MonitorPlay className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="truncate" title={t("capture.title")}>{t("capture.title")}</span>
            </span>
          }
          hint={t("capture.hint")}
        >
          <Switch
            checked={grabberOn}
            disabled={busy === "grabber" || status === "unreachable"}
            onCheckedChange={(v) => {
              setGrabber(v);
              void act("grabber", () => setGrabberAction(v)).then((ok) => !ok && setGrabber(null));
            }}
            aria-label={t("capture.switch")}
          />
        </Field>
        <Button variant="ghost" size="sm" className="justify-self-start sm:justify-self-auto" loading={busy === "clear"} onClick={() => void act("clear", () => clearHyperPriorityAction(40), t("effectsCleared"))}>
          <Eraser className="size-3.5" aria-hidden /> {t("clearEffects")}
        </Button>
      </div>

      <WallCard wall={wall} busy={busy === "wall"} onApply={(w) => act("wall", () => setWallCompensationAction(w), t("wall.applied"))} />

      <Subsection title={t("groups.music")}>{effectButtons(MUSIC_EFFECTS, Music2)}</Subsection>
      <Subsection title={t("groups.ambient")}>{effectButtons(AMBIENT_EFFECTS, Zap)}</Subsection>

      <Subsection
        title={
          <span className="flex items-center gap-1.5">
            <Bell className="size-3.5 shrink-0" aria-hidden />
            {t("notify.title")}
          </span>
        }
        hint={t("notify.hint")}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {NOTIFY_PALETTE.map((n) => {
            const label = NOTIFY_APP_KEY[n.app] ? t(`notify.apps.${NOTIFY_APP_KEY[n.app]!}`) : n.label;
            return (
              <button
                key={n.app}
                type="button"
                title={label}
                onClick={() => void act(n.app, () => notifyFlashAction({ color: n.color, durationMs: 1500 }))}
                className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-primary", FOCUS)}
              >
                <span className="size-3 shrink-0 rounded-full" style={{ background: `rgb(${n.color.join(" ")})` }} aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
              </button>
            );
          })}
        </div>
        {lastNotif && (
          <p className="text-xs text-muted">
            {t("notify.last")}: <span className="text-fg">{String(lastNotif.attributes["android.title"] ?? lastNotif.attributes.package ?? "")}</span>
          </p>
        )}
      </Subsection>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {HYPERHDR_INSTANCES.map((i) => (
          <div key={i.id} className="min-w-0 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium uppercase tracking-wider text-muted">{t("instances.label", { n: i.id })}</span>
              <Badge variant="muted">{t("instances.fps", { n: i.fps })}</Badge>
            </div>
            <p className="mt-1 truncate text-sm font-medium" title={t(`instances.${i.id}.name`)}>{t(`instances.${i.id}.name`)}</p>
            <p className="truncate text-xs text-muted" title={t(`instances.${i.id}.target`)}>{t(`instances.${i.id}.target`)}</p>
          </div>
        ))}
      </div>
      </div>
    </Panel>
  );
}

/**
 * The monitor strip lights a painted wall; the eye sees strip × wall
 * reflectance. Pick the wall colour, pull the slider until white on screen
 * looks white on the wall.
 */
function WallCard({ wall, busy, onApply }: { wall: WallSetting; busy: boolean; onApply: (w: WallSetting) => Promise<boolean> }) {
  const t = useTranslations("ambilight.wall");
  const [hex, setHex] = React.useState(wall.wallHex);
  const [strength, setStrength] = React.useState(Math.round(wall.strength * 100));
  const dirty = hex !== wall.wallHex || strength !== Math.round(wall.strength * 100);
  const commit = (s = strength, h = hex) => onApply({ wallHex: h, strength: s / 100 });
  return (
    <Subsection title={t("title")} hint={t("description")}>
      <Field inline label={t("colour")}>
        <input
          type="color"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => dirty && commit()}
          aria-label={t("colourLabel")}
          className={cn("h-8 w-10 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5", FOCUS)}
        />
      </Field>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs text-muted">
          <span className="min-w-0 truncate">{t("strength")}</span>
          <span className="flex items-center gap-2 tabular-nums">
            {busy && <span className="pulse-dot" aria-hidden />}
            {strength}%
          </span>
        </div>
        <Slider
          min={0}
          max={100}
          step={5}
          value={strength}
          onChange={setStrength}
          onCommit={(v) => commit(v)}
          aria-label={t("strength")}
          track={`linear-gradient(90deg, ${hex} 0%, white 100%)`}
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="min-w-0 truncate text-xs text-muted">{t("preview")}</span>
        <span className="h-4 w-16 rounded-sm border border-border" style={{ background: previewOnWall(hex, strength / 100) }} aria-hidden />
      </div>
    </Subsection>
  );
}

// Same maths as New-WallCompensation (ambilight/hyperhdr-layout.ps1): the
// strip's white after per-channel gains, seen through the wall's reflectance.
function previewOnWall(hex: string, strength: number): string {
  const refl = [1, 3, 5].map((i) => Math.max(0.2, parseInt(hex.slice(i, i + 2), 16) / 255));
  const inv = refl.map((r) => 1 / r);
  const m = Math.max(...inv);
  const out = refl.map((r, i) => {
    const k = 1 + strength * ((inv[i] ?? 1) / m - 1);
    return Math.round(255 * Math.min(1, k * r * 1.6));
  });
  return `rgb(${out.join(" ")})`;
}
