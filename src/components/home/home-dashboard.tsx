"use client";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CopilotSignals } from "@/lib/copilot/signals-schema";
import type { DisplaySettings } from "@/lib/display/settings-meta";
import type { HomeAccessView } from "@/lib/home/access-model";
import type { ButtonBindings } from "@/lib/home/button-bindings-schema";
import { AMBILIGHT_MODES, type RoomId } from "@/lib/home/catalog";
import type { HaState } from "@/lib/home/ha-client";
import type { NutritionProfile } from "@/lib/nutrition/schema";
import type { NutritionSummary } from "@/lib/nutrition/summary";
import type { Pomodoro, TurzxSettings } from "@/lib/turzx/settings";
import { cn } from "@/lib/utils";
import { setAmbilightModeAction } from "@/server/actions/home";
import { armIntercomAction } from "@/server/actions/intercom";
import { addWaterAction } from "@/server/actions/nutrition";
import type { PlacedDevice, WallSetting } from "@/server/queries/home";
import { BellRing, Bot, Clapperboard, DoorOpen, Droplets, Eye, GlassWater, Lamp, Lightbulb, MonitorSmartphone, MousePointerClick, Music2, Tablet, Thermometer, Users } from "lucide-react";
import { AnimatePresence, LayoutGroup, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import * as React from "react";
import { toast } from "sonner";
import { KIND_ICON } from "./device-icon";
import { DeviceSheet } from "./device-sheet";
import type { FamilyCardProps } from "./family-card";
import { FloorPlan } from "./floor-plan";
import { deviceLayoutId, EASE_OUT, SPRING, SPRING_SOFT, TabSkeleton, withFade, type DeviceOrigin } from "./home-motion";
import { IntercomCard, type IntercomCardState } from "./intercom-card";
import { HOME_TABS, normalizeHomeTab, SETTINGS_SECTIONS, type HomeTab, type SettingsSection } from "./tabs";
import { useHomeAction } from "./use-home-action";
import { countLightsOn, cssColor, HomeStatesProvider, isOn, useEntity, useHomeStates } from "./use-home-states";

// HM-49: the non-default tabs load on first visit, with a skeleton that crossfades into the content.
const AmbilightPanel = dynamic(() => import("./ambilight-panel").then((x) => withFade(x.AmbilightPanel)), { loading: () => <TabSkeleton cards={3} /> });
const NotifyCenterCard = dynamic(() => import("./notify-card").then((x) => withFade(x.NotifyCenterCard)), { loading: () => <TabSkeleton cards={1} /> });
const PairedDevicesCard = dynamic(() => import("./paired-devices-card").then((x) => withFade(x.PairedDevicesCard)), { loading: () => <TabSkeleton cards={1} /> });
const NutritionCard = dynamic(() => import("./nutrition-card").then((x) => withFade(x.NutritionCard)), { loading: () => <TabSkeleton cards={3} /> });
const FamilyCard = dynamic(() => import("./family-card").then((x) => withFade(x.FamilyCard)), { loading: () => <TabSkeleton /> });
const TurzxCard = dynamic(() => import("./turzx-card").then((x) => withFade(x.TurzxCard)), { loading: () => <TabSkeleton /> });
const DisplayCard = dynamic(() => import("./display-card").then((x) => withFade(x.DisplayCard)), { loading: () => <TabSkeleton /> });
const ButtonBindingsCard = dynamic(() => import("./button-bindings-card").then((x) => withFade(x.ButtonBindingsCard)), { loading: () => <TabSkeleton /> });
const CopilotSignalsCard = dynamic(() => import("./copilot-signals-card").then((x) => withFade(x.CopilotSignalsCard)), { loading: () => <TabSkeleton /> });

const SECTION_ICON = { family: Users, turzx: MonitorSmartphone, nestHub: Tablet, deskButton: MousePointerClick, copilot: Bot } as const;
const MODE_ICON = { movie: Clapperboard, music: Music2, off: Lamp } as const;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const AccessContext = React.createContext<HomeAccessView>({ role: "owner", rooms: {}, canOpenDoor: true, canManage: true, canControlAny: true, userId: "", displayName: "" });
export const useHomeAccess = () => React.useContext(AccessContext);
const canControlRoom = (a: HomeAccessView, room: RoomId) => a.rooms[room] === "control";

type Selection = { id: string; origin: DeviceOrigin } | null;

export function HomeDashboard({
  access,
  family,
  devices,
  initialStates,
  haUrl,
  initialTab = "home",
  initialSection = "turzx",
  wall,
  turzx,
  display,
  pomodoro,
  copilot,
  rgbLights,
  nutrition,
  nutritionProfile,
  intercom,
  espToken,
  buttons,
  haScripts,
}: {
  access: HomeAccessView;
  family: Omit<FamilyCardProps, "me"> | null;
  devices: PlacedDevice[];
  initialStates: Record<string, HaState>;
  haUrl: string | null;
  initialTab?: HomeTab;
  initialSection?: SettingsSection;
  wall: WallSetting;
  turzx: TurzxSettings;
  display: DisplaySettings;
  pomodoro: Pomodoro;
  copilot: CopilotSignals;
  rgbLights: Array<{ id: string; name: string }>;
  nutrition: NutritionSummary;
  nutritionProfile: NutritionProfile;
  intercom: IntercomCardState;
  espToken: string;
  buttons: ButtonBindings;
  haScripts: string[];
}) {
  const t = useTranslations("home");
  const reduced = useReducedMotion();
  const [selected, setSelected] = React.useState<Selection>(null);
  const device = devices.find((d) => d.id === selected?.id) ?? null;
  const tabs = HOME_TABS.filter((id) => (id === "settings" ? access.canManage : id === "ambilight" ? access.canControlAny : true));
  const [{ tab, section }, setNav] = useQueryStates(
    {
      tab: parseAsStringLiteral(HOME_TABS).withDefault(initialTab),
      section: parseAsStringLiteral(SETTINGS_SECTIONS).withDefault(initialSection),
    },
    { history: "replace", scroll: false, shallow: true },
  );
  const navigate = (nextTab: HomeTab, nextSection?: SettingsSection) => {
    void setNav({ tab: nextTab, section: nextTab === "settings" ? (nextSection ?? section) : null });
  };
  const active: HomeTab = tabs.includes(tab) ? tab : "home";
  const select = (origin: DeviceOrigin) => (id: string) => setSelected({ id, origin });
  const shift = reduced ? 0 : 8;
  const stripRef = React.useRef<HTMLDivElement>(null);
  const fade = useEdgeFade(stripRef);
  React.useEffect(() => {
    const tabEl = stripRef.current?.querySelector<HTMLElement>(`[data-home-tab="${active}"]`);
    tabEl?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [active, reduced]);

  const body = (id: HomeTab) => {
    switch (id) {
      case "home":
        return (
          <div className="space-y-6">
            <Vitals />
            <QuickActions water={nutrition.water} intercom={intercom} onSettings={(s) => navigate("settings", s)} />
            <FloorPlan devices={devices} selected={selected?.id ?? null} onSelect={select("dot")} canArrange={access.canManage} />
            <DeviceGrid devices={devices} onSelect={select("tile")} openId={selected?.origin === "tile" ? selected.id : null} />
            <IntercomCard initial={intercom} token={espToken} canOpen={access.canOpenDoor} />
          </div>
        );
      case "ambilight":
        return <AmbilightPanel wall={wall} />;
      case "notifications":
        return (
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <NotifyCenterCard />
            <PairedDevicesCard />
          </div>
        );
      case "nutrition":
        return <NutritionCard initial={nutrition} profile={nutritionProfile} />;
      case "settings":
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)] lg:items-start">
            <SettingsNav value={section} onChange={(s) => navigate("settings", s)} />
            <div className="min-w-0 max-w-3xl">
              <AnimatePresence mode="wait" initial={false}>
                <m.div key={section} initial={{ opacity: 0, y: shift }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -shift }} transition={{ duration: 0.22, ease: EASE_OUT }}>
                  {section === "family" && family && <FamilyCard {...family} me={access.userId} />}
                  {section === "turzx" && <TurzxCard initial={turzx} pomodoro={pomodoro} defaultOpen />}
                  {section === "nestHub" && <DisplayCard initial={display} espToken={espToken} defaultOpen />}
                  {section === "deskButton" && <ButtonBindingsCard initial={buttons} scripts={haScripts} defaultOpen />}
                  {section === "copilot" && <CopilotSignalsCard initial={copilot} lights={rgbLights} defaultOpen />}
                </m.div>
              </AnimatePresence>
            </div>
          </div>
        );
    }
  };

  return (
    <AccessContext.Provider value={access}>
      <HomeStatesProvider initial={initialStates}>
        <div className="space-y-5">
          <Tabs value={active} onValueChange={(v) => navigate(normalizeHomeTab(v))}>
            <div
              ref={stripRef}
              data-fade={fade}
              className={cn(
                "-mx-4 overflow-x-auto scroll-px-4 px-4 py-1 [scrollbar-width:none] sm:mx-0 sm:scroll-px-0 sm:px-0 [&::-webkit-scrollbar]:hidden",
                "data-[fade=left]:[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
                "data-[fade=right]:[mask-image:linear-gradient(to_left,transparent,black_2rem)]",
                "data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2rem),transparent)]",
              )}
            >
              <LayoutGroup id="home-tabs">
                <TabsList aria-label={t("tabs.label")} className="h-10 w-max justify-start gap-0.5">
                  {tabs.map((id) => (
                    <TabsTrigger
                      key={id}
                      value={id}
                      data-home-tab={id}
                      className={cn("relative px-3.5 py-1.5 data-[state=active]:bg-transparent data-[state=active]:shadow-none", FOCUS)}
                    >
                      {active === id && <m.span layoutId="home-tab-indicator" aria-hidden className="absolute inset-0 rounded-[calc(var(--radius-md)-2px)] bg-surface shadow-sm" transition={SPRING} />}
                      <span className="relative">{t(`tabs.${id}`)}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </LayoutGroup>
            </div>

            {/* One panel whose id follows the active tab; its body crossfades between tabs. */}
            <TabsContent value={active}>
              <AnimatePresence mode="wait" initial={false}>
                <m.div key={active} initial={{ opacity: 0, y: shift }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -shift }} transition={{ duration: 0.22, ease: EASE_OUT }} className="min-w-0">
                  {body(active)}
                </m.div>
              </AnimatePresence>
            </TabsContent>
          </Tabs>
        </div>
        <DeviceSheet
          device={device}
          haUrl={haUrl}
          onClose={() => setSelected(null)}
          readOnly={device ? !canControlRoom(access, device.room) : false}
          layoutId={selected ? deviceLayoutId(selected.origin, selected.id) : undefined}
        />
      </HomeStatesProvider>
    </AccessContext.Provider>
  );
}

type EdgeFade = "none" | "left" | "right" | "both";

/** Which side(s) of a horizontal scroller still hide content: drives the edge fade mask. */
function useEdgeFade(ref: React.RefObject<HTMLElement | null>): EdgeFade {
  const [fade, setFade] = React.useState<EdgeFade>("none");
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [ref]);
  return fade;
}

function SettingsNav({ value, onChange }: { value: SettingsSection; onChange: (s: SettingsSection) => void }) {
  const t = useTranslations("home.settings");
  return (
    <nav aria-label={t("label")} className="-mx-4 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:mx-0 sm:px-0 lg:overflow-visible [&::-webkit-scrollbar]:hidden">
      <LayoutGroup id="home-settings-nav">
        <ul className="flex w-max gap-1 lg:w-auto lg:flex-col">
          {SETTINGS_SECTIONS.map((id) => {
            const Icon = SECTION_ICON[id];
            const active = id === value;
            const title = t(`${id}.title`);
            const hint = t(`${id}.hint`);
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onChange(id)}
                  aria-current={active ? "page" : undefined}
                  title={`${title} — ${hint}`}
                  className={cn(
                    "relative flex w-full items-start gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors lg:whitespace-normal",
                    FOCUS,
                    active ? "font-medium text-fg" : "text-muted hover:bg-bg-muted hover:text-fg",
                  )}
                >
                  {active && <m.span layoutId="home-settings-indicator" aria-hidden className="absolute inset-0 rounded-lg bg-surface shadow-sm" transition={SPRING} />}
                  <Icon className="relative mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="relative min-w-0">
                    <span className="block">{title}</span>
                    <span className="hidden text-xs font-normal text-muted lg:line-clamp-2">{hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </LayoutGroup>
    </nav>
  );
}

/** One-tap actions that used to need a form: ambilight scene, a glass of water, arming the intercom. */
function QuickActions({ water, intercom, onSettings }: { water: NutritionSummary["water"]; intercom: IntercomCardState; onSettings: (s: SettingsSection) => void }) {
  const t = useTranslations("home.quick");
  const access = useHomeAccess();
  const reduced = useReducedMotion();
  const [ml, setMl] = React.useState(water.ml);
  const [mode, setMode] = React.useState<string | null>(null);
  const [pulse, setPulse] = React.useState<{ key: number; ml: number } | null>(null);
  const armed = (intercom.autoOpenUntil ?? 0) > Date.now();
  const modeAct = useHomeAction(setAmbilightModeAction);
  const waterAct = useHomeAction(addWaterAction);
  const armAct = useHomeAction(armIntercomAction, { success: t("armed", { n: 30 }) });

  const applyMode = async (id: (typeof AMBILIGHT_MODES)[number]["id"]) => {
    const r = await modeAct.run(id);
    if (r.ok) {
      setMode(id);
      toast.success(t("modeApplied", { name: t(`mode.${id}`) }));
    }
  };
  const drink = async (amount: number) => {
    const r = await waterAct.run(amount);
    if (r.ok) {
      setMl((v) => v + amount);
      setPulse({ key: Date.now(), ml: amount });
      toast.success(t("waterAdded", { ml: amount }));
    }
  };
  React.useEffect(() => {
    if (!pulse) return;
    const id = setTimeout(() => setPulse(null), 1200);
    return () => clearTimeout(id);
  }, [pulse]);

  const pct = water.targetMl > 0 ? Math.min(100, Math.round((ml / water.targetMl) * 100)) : 0;
  return (
    <section aria-label={t("label")} className="surface p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {access.canControlAny && (
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-medium text-fg-muted">{t("ambilight")}</p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2">
              {AMBILIGHT_MODES.map((md) => {
                const Icon = MODE_ICON[md.id];
                const on = mode === md.id;
                const label = t(`mode.${md.id}`);
                return (
                  <Button
                    key={md.id}
                    variant={on ? "primary" : "secondary"}
                    size="sm"
                    disabled={modeAct.pending}
                    aria-pressed={on}
                    title={label}
                    className="h-auto min-h-8 min-w-0 justify-start gap-2 whitespace-normal py-1.5 text-left"
                    onClick={() => void applyMode(md.id)}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="line-clamp-2 min-w-0 text-balance">{label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}
        <div className="min-w-0 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium text-fg-muted">{t("water")}</p>
            <p className="relative shrink-0 text-xs tabular-nums text-muted">
              {t("waterProgress", { ml, target: water.targetMl })}
              <AnimatePresence>
                {pulse && (
                  <m.span
                    key={pulse.key}
                    aria-hidden
                    initial={{ opacity: 0, y: 0, scale: 0.9 }}
                    animate={{ opacity: 1, y: reduced ? 0 : -14, scale: 1 }}
                    exit={{ opacity: 0, y: reduced ? 0 : -22 }}
                    transition={SPRING_SOFT}
                    className="pointer-events-none absolute right-0 top-0 rounded-full bg-primary px-1.5 font-medium text-primary-fg"
                  >
                    {t("addMl", { ml: pulse.ml })}
                  </m.span>
                )}
              </AnimatePresence>
            </p>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("water")}>
            <m.div className="h-full rounded-full bg-primary" initial={false} animate={{ width: `${pct}%` }} transition={SPRING_SOFT} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={waterAct.pending} onClick={() => void drink(250)}>
              <GlassWater className="size-4" aria-hidden /> {t("addMl", { ml: 250 })}
            </Button>
            <Button size="sm" variant="ghost" disabled={waterAct.pending} onClick={() => void drink(100)}>
              {t("addMl", { ml: 100 })}
            </Button>
          </div>
        </div>
        {access.canOpenDoor && (
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-medium text-fg-muted">{t("intercom")}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={armed ? "primary" : "secondary"} disabled={armAct.pending} onClick={() => void armAct.run(30)}>
                <BellRing className="size-4" aria-hidden /> {t("armFor", { n: 30 })}
              </Button>
              {access.canManage && (
                <Button size="sm" variant="ghost" onClick={() => onSettings("deskButton")}>
                  <MousePointerClick className="size-4" aria-hidden /> {t("deskButton")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Vitals() {
  const t = useTranslations("home.vitals");
  const temp = useEntity("sensor.temperature_and_humidity_sensor_temperature");
  const hum = useEntity("sensor.temperature_and_humidity_sensor_humidity");
  const door = useEntity("binary_sensor.main_door_door");
  const { states } = useHomeStates();
  const lightsOn = countLightsOn(states);

  const items = [
    { icon: Thermometer, label: t("bedroom"), value: temp ? `${Number(temp.state).toFixed(1)}°` : "—" },
    { icon: Droplets, label: t("humidity"), value: hum ? `${Math.round(Number(hum.state))}%` : "—" },
    { icon: DoorOpen, label: t("mainDoor"), value: door ? (door.state === "on" ? t("open") : t("closed")) : "—", warn: door?.state === "on" },
    { icon: Lightbulb, label: t("lightsOn"), value: String(lightsOn), lit: lightsOn > 0 },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="surface flex min-w-0 items-center gap-3 px-3 py-2.5">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", it.warn ? "bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] text-warning-text" : it.lit ? "bg-[color-mix(in_oklch,var(--color-lit)_22%,transparent)] text-lit-text" : "bg-bg-muted text-muted")}>
            <it.icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-fg-muted" title={it.label}>{it.label}</p>
            <p className="truncate text-sm font-semibold leading-tight tabular-nums">{it.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeviceGrid({ devices, onSelect, openId }: { devices: PlacedDevice[]; onSelect: (id: string) => void; openId: string | null }) {
  const t = useTranslations("home.rooms");
  const access = useHomeAccess();
  const rooms = ["bedroom", "living_room", "kitchen", "office"] as const;
  return (
    <div className="space-y-5">
      {rooms.map((r) => {
        const list = devices.filter((d) => d.room === r);
        if (!list.length) return null;
        const viewOnly = !canControlRoom(access, r);
        return (
          <section key={r} aria-label={t(r)} className="space-y-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-muted">
              {t(r)}
              {viewOnly && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-xs">
                  <Eye className="size-3" aria-hidden />
                  {t("viewOnly")}
                </span>
              )}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5">
              {list.map((d, i) => (
                <m.div key={d.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_OUT, delay: Math.min(i, 8) * 0.035 }} className="min-w-0">
                  <DeviceTile device={d} open={openId === d.id} onSelect={() => onSelect(d.id)} />
                </m.div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DeviceTile({ device, open, onSelect }: { device: PlacedDevice; open: boolean; onSelect: () => void }) {
  const t = useTranslations("home.device");
  const s = useEntity(device.entity);
  const on = device.entity ? isOn(s) : device.id === "dxlight" || device.id === "pc";
  const color = cssColor(s);
  const Icon = KIND_ICON[device.kind];
  const sub =
    device.kind === "sensor" && s
      ? `${Number(s.state).toFixed(1)} ${String(s.attributes.unit_of_measurement ?? "")}`
      : device.kind === "ac" && s
        ? s.state === "off"
          ? t("off")
          : `${s.state} · ${s.attributes.temperature ?? "?"}°`
        : device.kind === "presence" && s
          ? s.state === "on"
            ? t("occupied")
            : t("clear")
          : device.kind === "door" && s
            ? s.state === "on"
              ? t("open")
              : t("closed")
            : device.entity
              ? s
                ? on
                  ? t("on")
                  : t("off")
                : t("unavailable")
              : device.via;
  return (
    <m.button
      type="button"
      layoutId={deviceLayoutId("tile", device.id)}
      onClick={onSelect}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(
        "surface card-hover flex w-full min-w-0 items-center gap-3 p-3 text-left",
        FOCUS,
        on && "border-[color-mix(in_oklch,var(--color-lit)_45%,var(--color-border))] shadow-[0_0_28px_-10px_var(--color-lit)]",
      )}
      title={`${device.name}${sub ? ` · ${sub}` : ""}`}
    >
      <span
        className={cn("grid size-9 shrink-0 place-items-center rounded-full transition-colors", on ? "text-lit-fg" : "bg-bg-muted text-muted")}
        // a light's own colour is data; everything else that is on uses the lit token
        style={on ? { background: color ?? "var(--color-lit)" } : undefined}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 block text-sm font-medium leading-tight">{device.name}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
    </m.button>
  );
}
