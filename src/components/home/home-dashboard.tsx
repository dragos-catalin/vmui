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
import { motion } from "motion/react";
import { useTranslations } from "next-intl";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import * as React from "react";
import { toast } from "sonner";
import { AmbilightPanel } from "./ambilight-panel";
import { ButtonBindingsCard } from "./button-bindings-card";
import { CopilotSignalsCard } from "./copilot-signals-card";
import { KIND_ICON } from "./device-icon";
import { DeviceSheet } from "./device-sheet";
import { DisplayCard } from "./display-card";
import { FamilyCard, type FamilyCardProps } from "./family-card";
import { FloorPlan } from "./floor-plan";
import { IntercomCard, type IntercomCardState } from "./intercom-card";
import { NotifyCenterCard } from "./notify-card";
import { NutritionCard } from "./nutrition-card";
import { PairedDevicesCard } from "./paired-devices-card";
import { HOME_TABS, normalizeHomeTab, SETTINGS_SECTIONS, type HomeTab, type SettingsSection } from "./tabs";
import { TurzxCard } from "./turzx-card";
import { cssColor, HomeStatesProvider, isOn, useEntity, useHomeStates } from "./use-home-states";

const SECTION_ICON = { family: Users, turzx: MonitorSmartphone, nestHub: Tablet, deskButton: MousePointerClick, copilot: Bot } as const;
const MODE_ICON = { movie: Clapperboard, music: Music2, off: Lamp } as const;

const AccessContext = React.createContext<HomeAccessView>({ role: "owner", rooms: {}, canOpenDoor: true, canManage: true, canControlAny: true, userId: "", displayName: "" });
export const useHomeAccess = () => React.useContext(AccessContext);
const canControlRoom = (a: HomeAccessView, room: RoomId) => a.rooms[room] === "control";

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
  const [selected, setSelected] = React.useState<string | null>(null);
  const device = devices.find((d) => d.id === selected) ?? null;
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

  return (
    <AccessContext.Provider value={access}>
    <HomeStatesProvider initial={initialStates}>
      <div className="space-y-5">
        <Tabs value={tab} onValueChange={(v) => navigate(normalizeHomeTab(v))}>
          <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
            <TabsList aria-label={t("tabs.label")} className="h-10 w-max justify-start gap-0.5">
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id} className="px-3.5 py-1.5">{t(`tabs.${id}`)}</TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="home" className="space-y-6">
            <Vitals />
            <QuickActions water={nutrition.water} intercom={intercom} onSettings={(s) => navigate("settings", s)} />
            <FloorPlan devices={devices} selected={selected} onSelect={setSelected} canArrange={access.canManage} />
            <DeviceGrid devices={devices} onSelect={setSelected} />
            <IntercomCard initial={intercom} token={espToken} canOpen={access.canOpenDoor} />
          </TabsContent>

          {access.canControlAny && (
            <TabsContent value="ambilight">
              <AmbilightPanel wall={wall} />
            </TabsContent>
          )}

          <TabsContent value="notifications" className="space-y-4">
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <NotifyCenterCard />
              <PairedDevicesCard />
            </div>
          </TabsContent>

          <TabsContent value="nutrition">
            <NutritionCard initial={nutrition} profile={nutritionProfile} />
          </TabsContent>

          {access.canManage && <TabsContent value="settings">
            <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
              <SettingsNav value={section} onChange={(s) => navigate("settings", s)} />
              <div className="min-w-0 max-w-3xl">
                {section === "family" && family && <FamilyCard {...family} me={access.userId} />}
                {section === "turzx" && <TurzxCard initial={turzx} pomodoro={pomodoro} defaultOpen />}
                {section === "nestHub" && <DisplayCard initial={display} espToken={espToken} defaultOpen />}
                {section === "deskButton" && <ButtonBindingsCard initial={buttons} scripts={haScripts} defaultOpen />}
                {section === "copilot" && <CopilotSignalsCard initial={copilot} lights={rgbLights} defaultOpen />}
              </div>
            </div>
          </TabsContent>}
        </Tabs>
      </div>
      <DeviceSheet device={device} haUrl={haUrl} onClose={() => setSelected(null)} readOnly={device ? !canControlRoom(access, device.room) : false} />
    </HomeStatesProvider>
    </AccessContext.Provider>
  );
}

function SettingsNav({ value, onChange }: { value: SettingsSection; onChange: (s: SettingsSection) => void }) {
  const t = useTranslations("home.settings");
  return (
    <nav aria-label={t("label")} className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 lg:overflow-visible [&::-webkit-scrollbar]:hidden">
      <ul className="flex w-max gap-1 lg:w-auto lg:flex-col">
        {SETTINGS_SECTIONS.map((id) => {
          const Icon = SECTION_ICON[id];
          const active = id === value;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
                  active ? "bg-[var(--color-surface)] font-medium text-[var(--color-fg)] shadow-sm" : "text-muted hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate">{t(`${id}.title`)}</span>
                  <span className="hidden truncate text-xs font-normal text-muted lg:block">{t(`${id}.hint`)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One-tap actions that used to need a form: ambilight scene, a glass of water, arming the intercom. */
function QuickActions({ water, intercom, onSettings }: { water: NutritionSummary["water"]; intercom: IntercomCardState; onSettings: (s: SettingsSection) => void }) {
  const t = useTranslations("home.quick");
  const access = useHomeAccess();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [ml, setMl] = React.useState(water.ml);
  const [mode, setMode] = React.useState<string | null>(null);
  const armed = (intercom.autoOpenUntil ?? 0) > Date.now();
  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done?: () => void) => {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? t("failed"));
    else done?.();
  };
  const pct = water.targetMl > 0 ? Math.min(100, Math.round((ml / water.targetMl) * 100)) : 0;
  return (
    <section aria-label={t("label")} className="surface p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {access.canControlAny && <div className="min-w-0 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">{t("ambilight")}</p>
          <div className="grid grid-cols-3 gap-2">
            {AMBILIGHT_MODES.map((m) => {
              const Icon = MODE_ICON[m.id];
              const active = mode === m.id;
              return (
                <Button
                  key={m.id}
                  variant={active ? "primary" : "secondary"}
                  size="sm"
                  disabled={busy !== null}
                  aria-pressed={active}
                  className="min-w-0 justify-start gap-2"
                  onClick={() => run(m.id, () => setAmbilightModeAction(m.id), () => { setMode(m.id); toast.success(t("modeApplied", { name: t(`mode.${m.id}`) })); })}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{t(`mode.${m.id}`)}</span>
                </Button>
              );
            })}
          </div>
        </div>}
        <div className="min-w-0 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">{t("water")}</p>
            <p className="shrink-0 text-xs tabular-nums text-muted">{t("waterProgress", { ml, target: water.targetMl })}</p>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("water")}>
            <div className="h-full rounded-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run("w250", () => addWaterAction(250), () => { setMl((v) => v + 250); toast.success(t("waterAdded", { ml: 250 })); })}>
              <GlassWater className="size-4" aria-hidden /> +250 ml
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run("w100", () => addWaterAction(100), () => { setMl((v) => v + 100); toast.success(t("waterAdded", { ml: 100 })); })}>
              +100 ml
            </Button>
          </div>
        </div>
        {access.canOpenDoor && <div className="min-w-0 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">{t("intercom")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={armed ? "primary" : "secondary"} disabled={busy !== null} onClick={() => run("arm", () => armIntercomAction(30), () => toast.success(t("armed", { n: 30 })))}>
              <BellRing className="size-4" aria-hidden /> {t("armFor", { n: 30 })}
            </Button>
            {access.canManage && <Button size="sm" variant="ghost" onClick={() => onSettings("deskButton")}>
              <MousePointerClick className="size-4" aria-hidden /> {t("deskButton")}
            </Button>}
          </div>
        </div>}
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
  const lightsOn = Object.values(states).filter((s) => s.entity_id.startsWith("light.") && s.entity_id !== "light.hyperhdr" && isOn(s)).length;

  const items = [
    { icon: Thermometer, label: t("bedroom"), value: temp ? `${Number(temp.state).toFixed(1)}°` : "—" },
    { icon: Droplets, label: t("humidity"), value: hum ? `${Math.round(Number(hum.state))}%` : "—" },
    { icon: DoorOpen, label: t("mainDoor"), value: door ? (door.state === "on" ? t("open") : t("closed")) : "—", warn: door?.state === "on" },
    { icon: Lightbulb, label: t("lightsOn"), value: String(lightsOn) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      {items.map((it) => (
        <div key={it.label} className="surface flex items-center gap-3 px-3 py-2.5">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", it.warn ? "bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]" : "bg-[var(--color-bg-muted)] text-muted")}>
            <it.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs uppercase tracking-wider text-muted">{it.label}</p>
            <p className="truncate text-sm font-semibold leading-tight tabular-nums">{it.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeviceGrid({ devices, onSelect }: { devices: PlacedDevice[]; onSelect: (id: string) => void }) {
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
            <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
              {t(r)}
              {viewOnly && <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 normal-case tracking-normal"><Eye className="size-3" aria-hidden />{t("viewOnly")}</span>}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5">
              {list.map((d, i) => (
                <motion.div key={d.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}>
                  <DeviceTile device={d} onSelect={() => onSelect(d.id)} />
                </motion.div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DeviceTile({ device, onSelect }: { device: PlacedDevice; onSelect: () => void }) {
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
                ? s.state
                : t("unavailable")
              : device.via;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="surface card-hover flex min-w-0 items-center gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      title={`${device.name}${sub ? ` · ${sub}` : ""}`}
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full transition-colors"
        style={{ background: on ? color ?? "var(--color-primary)" : "var(--color-bg-muted)", color: on ? "#0b0e16" : "var(--color-fg-muted)" }}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{device.name}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
    </button>
  );
}
