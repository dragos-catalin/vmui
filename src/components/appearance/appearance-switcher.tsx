"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACCENTS, ACCENT_HUE, DENSITIES, SURFACES, THEMES, VIBES, VIBE_PRESET, accentHueOf, type Accent, type Vibe } from "@/lib/appearance/model";
import { cn } from "@/lib/utils";
import { Check, Contrast, Laptop, Layers, Moon, Palette, Rows3, Square, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

const THEME_ICON = { light: Sun, dark: Moon, system: Laptop } as const;
const SURFACE_ICON = { glass: Layers, flat: Square, contrast: Contrast } as const;
const MOTION_OPTIONS = ["system", "reduce", "full"] as const;
type MotionChoice = (typeof MOTION_OPTIONS)[number];
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

type PresetAccent = Exclude<Accent, "custom">;
const PRESET_ACCENTS = ACCENTS.filter((x): x is PresetAccent => x !== "custom");

/** Swatch colour from the same hue map the theme uses (primary: L 0.56 / C 0.16, matches the brand tokens). */
function swatch(hue: number): string {
  return `oklch(0.6 0.16 ${hue})`;
}

/** Vibe hue = the accent its preset applies, so the dot previews what you get. */
function vibeHue(v: Vibe): number {
  const accent = VIBE_PRESET[v].accent;
  return accent && accent !== "custom" ? ACCENT_HUE[accent] : ACCENT_HUE.ember;
}

/** Roving-tabindex radio group for swatch/card grids (arrow keys move + select, Home/End jump). */
function useRoving<T extends string>(values: readonly T[], value: T | undefined, onChange: (v: T) => void) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());
  const tabStop = value !== undefined && values.includes(value) ? value : values[0];
  const onKeyDown = (e: React.KeyboardEvent, current: T) => {
    const i = values.indexOf(current);
    let next: T | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = values[(i + 1) % values.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = values[(i - 1 + values.length) % values.length];
    else if (e.key === "Home") next = values[0];
    else if (e.key === "End") next = values.at(-1);
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  };
  const bind = (v: T) => ({
    ref: (el: HTMLButtonElement | null) => {
      if (el) refs.current.set(v, el);
      else refs.current.delete(v);
    },
    tabIndex: v === tabStop ? 0 : -1,
    onKeyDown: (e: React.KeyboardEvent) => onKeyDown(e, v),
  });
  return bind;
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-xs font-medium uppercase tracking-wider text-fg-muted">
      {children}
    </h3>
  );
}

export function AppearanceSwitcher() {
  const t = useTranslations("appearance");
  const { appearance: a, update, applyVibe } = useAppearance();
  const hue = accentHueOf(a);
  const ids = React.useId();
  const motion: MotionChoice = a.reducedMotion === null ? "system" : a.reducedMotion ? "reduce" : "full";
  const bindAccent = useRoving(PRESET_ACCENTS, a.accent === "custom" ? undefined : a.accent, (accent) => update({ accent }));
  const bindVibe = useRoving(VIBES, a.vibe, applyVibe);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("open")}>
              <Palette className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("open")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[min(80dvh,40rem)] w-[min(22rem,calc(100vw-1rem))] space-y-4 overflow-y-auto p-4" aria-label={t("open")}>
        <section className="space-y-2">
          <SectionTitle id={`${ids}-theme`}>{t("theme.label")}</SectionTitle>
          <ToggleGroup
            aria-labelledby={`${ids}-theme`}
            value={a.theme}
            onValueChange={(theme) => update({ theme })}
            className="grid w-full auto-cols-fr grid-flow-col"
            size="sm"
            options={THEMES.map((v) => {
              const I = THEME_ICON[v];
              return { value: v, icon: <I aria-hidden />, label: <span className="truncate">{t(`theme.${v}`)}</span> };
            })}
          />
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <SectionTitle id={`${ids}-accent`}>{t("accent.label")}</SectionTitle>
            <span className="text-xs tabular-nums text-fg-muted">{Math.round(hue)}°</span>
          </div>
          <div role="radiogroup" aria-labelledby={`${ids}-accent`} className="flex flex-wrap gap-2">
            {PRESET_ACCENTS.map((x) => {
              const selected = a.accent === x;
              return (
                <button
                  key={x}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={t(`accent.${x}`)}
                  title={t(`accent.${x}`)}
                  onClick={() => update({ accent: x })}
                  {...bindAccent(x)}
                  className={cn(
                    "grid size-7 place-items-center rounded-full border-2 transition-transform motion-safe:hover:scale-110",
                    FOCUS,
                    selected ? "border-fg" : "border-transparent",
                  )}
                  style={{ background: swatch(ACCENT_HUE[x]) }}
                >
                  {selected && <Check className="size-3.5 text-primary-fg" strokeWidth={3} aria-hidden />}
                </button>
              );
            })}
          </div>
          <label className="block space-y-1.5">
            <span className="block text-xs text-fg-muted">{t("accent.custom")}</span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={hue}
              onChange={(e) => update({ accent: "custom", accentHue: Number(e.target.value) })}
              aria-valuetext={`${Math.round(hue)}°`}
              className="vmui-range hue-range w-full"
            />
          </label>
        </section>

        <section className="space-y-2">
          <SectionTitle id={`${ids}-surface`}>{t("surface.label")}</SectionTitle>
          <ToggleGroup
            aria-labelledby={`${ids}-surface`}
            value={a.surface}
            onValueChange={(surface) => update({ surface })}
            className="grid w-full auto-cols-fr grid-flow-col"
            size="sm"
            options={SURFACES.map((v) => {
              const I = SURFACE_ICON[v];
              return { value: v, icon: <I aria-hidden />, label: <span className="truncate">{t(`surface.${v}`)}</span> };
            })}
          />
        </section>

        <section className="space-y-2">
          <SectionTitle id={`${ids}-density`}>{t("density.label")}</SectionTitle>
          <ToggleGroup
            aria-labelledby={`${ids}-density`}
            value={a.density}
            onValueChange={(density) => update({ density })}
            className="grid w-full auto-cols-fr grid-flow-col"
            size="sm"
            options={DENSITIES.map((v) => ({ value: v, icon: <Rows3 aria-hidden />, label: <span className="truncate">{t(`density.${v}`)}</span> }))}
          />
        </section>

        <section className="space-y-2">
          <SectionTitle id={`${ids}-motion`}>{t("motion.label")}</SectionTitle>
          <ToggleGroup
            aria-labelledby={`${ids}-motion`}
            value={motion}
            onValueChange={(v) => update({ reducedMotion: v === "system" ? null : v === "reduce" })}
            className="grid w-full auto-cols-fr grid-flow-col"
            size="sm"
            options={MOTION_OPTIONS.map((v) => ({ value: v, label: <span className="truncate">{t(`motion.${v}`)}</span> }))}
          />
          <p className="text-xs leading-snug text-fg-muted">{t(`motion.hint_${motion}`)}</p>
        </section>

        <label className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2">
          <span className="min-w-0">
            <span className="block text-xs font-medium">{t("ambient.label")}</span>
            <span className="block text-xs leading-snug text-fg-muted">{t("ambient.hint")}</span>
          </span>
          <Switch checked={a.ambient} onCheckedChange={(ambient) => update({ ambient })} aria-label={t("ambient.label")} />
        </label>

        <section className="space-y-2">
          <SectionTitle id={`${ids}-vibe`}>{t("vibe.label")}</SectionTitle>
          <div role="radiogroup" aria-labelledby={`${ids}-vibe`} className="grid grid-cols-2 gap-1.5">
            {VIBES.map((v: Vibe) => {
              const h = vibeHue(v);
              return (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={a.vibe === v}
                  onClick={() => applyVibe(v)}
                  {...bindVibe(v)}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] border px-2.5 py-2 text-left text-xs transition-colors",
                    FOCUS,
                    a.vibe === v ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_12%,transparent)]" : "border-border hover:bg-bg-muted",
                  )}
                >
                  <span
                    className="size-3 shrink-0 rounded-full"
                    style={{ background: `conic-gradient(${swatch(h)}, oklch(0.6 0.14 ${h - 40}), ${swatch(h)})` }}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium" title={t(`vibe.${v}.name`)}>
                      {t(`vibe.${v}.name`)}
                    </span>
                    <span className="block truncate text-fg-muted" title={t(`vibe.${v}.hint`)}>
                      {t(`vibe.${v}.hint`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </PopoverContent>
    </Popover>
  );
}
