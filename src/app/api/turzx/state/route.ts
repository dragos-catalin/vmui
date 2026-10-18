import { currentSignal, loadCopilotSignals } from "@/lib/copilot/signals";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { ensureActivityFeed, recentActivity } from "@/lib/esp/activity";
import { espAuthorized } from "@/lib/esp/auth";
import { ownerActor } from "@/lib/home/access";
import { ambilightSettings } from "@/lib/home/ambilight-settings";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { haConfig } from "@/lib/home/credentials";
import { ha, type HaState } from "@/lib/home/ha-client";
import { intercomState, isAutoOpenArmed } from "@/lib/home/intercom";
import { presenceEntityId } from "@/lib/home/presence";
import { ensureNotifyWatchers } from "@/lib/notify/watchers";
import { runCoach } from "@/lib/nutrition/coach";
import { currentNutritionEvent } from "@/lib/nutrition/events";
import { nutritionSummary, publishToHa } from "@/lib/nutrition/summary";
import { agentSessions, batteryReadings, bnrRates, calendarEvents, coinPrices, energyReadings, fleet, haHistory, healthReadings, hourlyForecast, moonPhase, photoPool, quoteOfTheDay, syncedLyrics, weatherForecast } from "@/lib/turzx/feeds";
import { allPcMetrics, pcMetrics, piMetrics } from "@/lib/turzx/pc-metrics";
import { loadPomodoro, loadTurzxSettings } from "@/lib/turzx/settings";
import { desc } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/turzx/state?k=<ESP_DISPLAY_TOKEN>
// Everything the desk-screen renderer (turzx/turzx.py) needs, in one poll.
// It runs on this PC, so PC metrics (CPU/GPU/RAM) are read locally by the
// renderer, not here. Must never throw: each block degrades to null.

const pick = (m: Map<string, HaState>, id: string) => {
  const s = m.get(id);
  return s ? { state: s.state, attributes: s.attributes, since: s.last_changed ?? null } : null;
};

/** Companion "Last notification" sensor → one flat event. `id` changes per
 *  notification (post time + package), so the renderer pops each exactly once. */
function phoneNotification(s: HaState | undefined) {
  if (!s || s.state === "unavailable" || s.state === "unknown") return null;
  const a = s.attributes as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const pkg = str("package");
  if (!pkg) return null;
  const title = str("android.title");
  const text = str("android.bigText") || str("android.text") || s.state;
  const postTime = typeof a.post_time === "number" ? (a.post_time as number) : new Date(s.last_changed ?? Date.now()).getTime();
  return {
    id: `${postTime}|${pkg}|${title}`.slice(0, 200),
    at: postTime,
    pkg,
    app: pkg.split(".").filter((p) => !["com", "org", "android", "app", "apps", "google", "samsung"].includes(p)).pop() ?? pkg,
    title,
    text,
    ongoing: Boolean(a.is_ongoing),
    group: Boolean(a.is_group_summary),
  };
}

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  ensureActivityFeed();
  ensureNotifyWatchers();
  let states = new Map<string, HaState>();
  try {
    states = new Map((await ha.states()).map((s) => [s.entity_id, s]));
  } catch {
    // HA down -> home/weather blocks null, renderer shows offline badge
  }
  const settings = await loadTurzxSettings();
  const enabled = new Set(settings.views.filter((v) => v.enabled).map((v) => v.id));
  const opt = (id: (typeof settings.views)[number]["id"]) => settings.views.find((v) => v.id === id)?.options ?? {};
  const list = (v: unknown, fallback: string[]) => (Array.isArray(v) && v.length ? v.map(String) : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
  const bgSources = new Set(settings.background.sources);
  for (const v of settings.views) if (v.enabled && v.background) for (const s of v.background.sources) bgSources.add(s);
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const lead = [...states.values()].find((s) => s.entity_id.startsWith("media_player.") && s.state === "playing" && s.attributes.media_title && s.attributes.media_artist);
  const [fx, crypto, photos, vms, tempHist, humHist, cal, quote, pomodoro, forecast, hourly, agents, lyrics, health] = await Promise.all([
    enabled.has("fx") ? bnrRates(list(opt("fx").currencies, ["EUR", "USD", "GBP"])) : null,
    enabled.has("crypto") ? coinPrices(list(opt("crypto").coins, ["bitcoin", "ethereum"]), str(opt("crypto").vs, "usd")) : null,
    bgSources.size || enabled.has("photo") ? photoPool([...bgSources]) : [],
    enabled.has("fleet") ? fleet() : null,
    enabled.has("climate") ? haHistory("sensor.temperature_and_humidity_sensor_temperature") : null,
    enabled.has("climate") ? haHistory("sensor.temperature_and_humidity_sensor_humidity") : null,
    enabled.has("calendar") || enabled.has("clock") ? calendarEvents(list(opt("calendar").entities, [...states.keys()].filter((k) => k.startsWith("calendar.")))) : null,
    enabled.has("quote") ? quoteOfTheDay(str(opt("quote").lang, "ro") === "en" ? "en" : "ro") : null,
    loadPomodoro(),
    enabled.has("weather") && states.has("weather.forecast_home") ? weatherForecast("weather.forecast_home") : null,
    enabled.has("weather") && states.has("weather.forecast_home") ? hourlyForecast("weather.forecast_home") : null,
    enabled.has("copilot") ? agentSessions(num(opt("copilot").activeMin, 30)) : null,
    enabled.has("media") && opt("media").lyrics !== false && lead ? syncedLyrics(String(lead.attributes.media_title), String(lead.attributes.media_artist), typeof lead.attributes.media_duration === "number" ? lead.attributes.media_duration : null) : null,
    enabled.has("health")
      ? healthReadings(states, str(opt("health").device, "dragos_s_s25_ultra"), {
          heightCm: num(opt("health").heightCm, 173),
          birthDate: str(opt("health").birthDate, "1993-12-12"),
          sex: str(opt("health").sex, "m") === "f" ? "f" : "m",
        })
      : null,
  ]);
  // Nutrition rides on the turzx poll: it is the only always-on loop in the
  // app, so it also drives the coach (self-limited to one push/day) and the
  // HA sensor mirror (every ~5 min).
  let nutrition: Awaited<ReturnType<typeof nutritionSummary>> | null = null;
  if (enabled.has("nutrition")) {
    try {
      // The desk screen is the owner's; it shows their journal.
      const o = await ownerActor();
      nutrition = await nutritionSummary(o && o.userId !== "solo" ? { userId: o.userId, isOwner: true } : null);
      const g = globalThis as unknown as { __vmuiNutriTick?: number };
      if (Date.now() - (g.__vmuiNutriTick ?? 0) > 5 * 60_000) {
        g.__vmuiNutriTick = Date.now();
        void publishToHa(nutrition);
        void runCoach(nutrition);
      }
    } catch {
      // DB hiccup: view shows nothing this poll
    }
  }
  const nEv = currentNutritionEvent();
  const amb = await ambilightSettings();
  const sig = currentSignal();
  const sigCfg = await loadCopilotSignals();
  // Same shape as a phone notification so the overlay pops it with no new code path.
  const ic = intercomState();
  // A ringing intercom outranks any agent card; same held-card path (pkg copilot.*, ongoing).
  const copilot = ic.ringingSince
    ? { id: `intercom|${ic.ringingSince}`, at: ic.ringingSince, pkg: "copilot.ask", app: "interfon", title: "Suna la interfon", text: isAutoOpenArmed() ? "Deschidere automata armata" : "Raspunde de pe telefon", ongoing: true, group: false, color: "#ff5a1f" }
    :
    sig && sigCfg.enabled && sigCfg.patterns[sig.event].turzx
      ? {
          id: sig.id,
          at: sig.at,
          pkg: `copilot.${sig.event}`,
          // badge line = the project, like the VS Code taskbar title; falls back to the harness name
          app: sig.project || sig.source,
          title: { ask: "Copilot asteapta raspuns", done: "Copilot a terminat", blocked: "Comanda blocata", failed: "A esuat" }[sig.event],
          text: [sig.chat, sig.text].filter(Boolean).join("\n"),
          ongoing: sig.active,
          group: false,
          color: sigCfg.patterns[sig.event].color,
        }
      : null;
  const lights = [...states.values()].filter((s) => s.entity_id.startsWith("light."));
  const media = [...states.values()].filter((s) => s.entity_id.startsWith("media_player.") && (s.state === "playing" || s.state === "paused"));
  const actions = await db.select({ action: auditLog.action, target: auditLog.target, at: auditLog.createdAt }).from(auditLog).orderBy(desc(auditLog.createdAt)).limit(6);
  let shopping: string[] = [];
  try {
    const r = (await ha.callService("todo", "get_items", { entity_id: "todo.shopping_list", status: "needs_action" })) as unknown as Record<string, { items?: Array<{ summary: string }> }>;
    shopping = (r["todo.shopping_list"]?.items ?? []).map((i) => i.summary);
  } catch {
    // todo list optional
  }
  return NextResponse.json(
    {
      now: Date.now(),
      haOnline: states.size > 0,
      haUrl: haConfig()?.url ?? null,
      settings,
      weather: pick(states, "weather.forecast_home"),
      forecast,
      hourly,
      moon: moonPhase(),
      sun: pick(states, "sun.sun"),
      inside: { temp: pick(states, "sensor.temperature_and_humidity_sensor_temperature"), hum: pick(states, "sensor.temperature_and_humidity_sensor_humidity") },
      home: {
        door: pick(states, "binary_sensor.main_door_door"),
        presence: (() => {
          const id = presenceEntityId(states);
          return id ? pick(states, id) : null;
        })(),
        acBedroom: pick(states, "climate.bedroom_ac"),
        acLiving: pick(states, "climate.living_room_ac_mami"),
        person: pick(states, "person.dragos"),
        lightsOn: lights.filter((l) => l.state === "on").length,
        lightsTotal: lights.length,
      },
      ambilight: {
        hyper: pick(states, "light.hyperhdr"),
        ambilight: ambilightStatus(states.get("light.hyperhdr")),
        strip: pick(states, "light.led_argb"),
        bar: pick(states, "light.desk_light_bar"),
        wallHex: amb.wallHex,
        wallStrength: amb.wallStrength,
      },
      media: media.map((m) => ({ id: m.entity_id, name: (m.attributes.friendly_name as string | undefined) ?? null, state: m.state, title: m.attributes.media_title ?? null, artist: m.attributes.media_artist ?? null, app: m.attributes.app_name ?? null, art: m.attributes.entity_picture ?? null, position: m.attributes.media_position ?? null, duration: m.attributes.media_duration ?? null, positionAt: m.attributes.media_position_updated_at ?? null })),
      activity: recentActivity(8),
      actions: actions.map((a) => ({ action: a.action.replace(/^home\./, ""), target: (a.target ?? "").split(".").pop() ?? "", at: a.at ? new Date(a.at).getTime() : null })),
      shopping,
      esp: { rssi: pick(states, "sensor.office_bluetooth_proxy_1_wifi_signal"), heap: pick(states, "sensor.office_bluetooth_proxy_1_heap_free"), uptime: pick(states, "sensor.office_bluetooth_proxy_1_uptime") },
      fx,
      crypto,
      photos,
      fleet: vms,
      climate: tempHist || humHist ? { temp: tempHist ?? [], hum: humHist ?? [] } : null,
      calendar: cal,
      quote,
      pomodoro,
      agents,
      lyrics: lyrics && lead ? { player: lead.entity_id, lines: lyrics } : null,
      energy: enabled.has("energy") ? { readings: energyReadings(states, list(opt("energy").entities, [])), pricePerKwh: num(opt("energy").pricePerKwh, 1.3) } : null,
      batteries: batteryReadings(states),
      health: health ? { ...health, stepsGoal: num(opt("health").stepsGoal, 8000), sleepGoalMin: num(opt("health").sleepGoalH, 8) * 60 } : null,
      notification: phoneNotification(states.get("sensor.dragos_s_s25_ultra_last_notification")),
      copilot,
      pc: pcMetrics(),
      pcs: allPcMetrics(),
      pi: piMetrics(),
      intercom: { ringing: ic.ringingSince !== null, since: ic.ringingSince, lastRingAt: ic.lastRingAt, lastOpenAt: ic.lastOpenAt, armedUntil: isAutoOpenArmed() ? ic.autoOpenUntil : null },
      nutrition,
      // same card shape as a phone notification; overlay pops it once per id
      nutritionEvent: nEv
        ? {
            id: `${nEv.at}|${nEv.kind}`,
            at: nEv.at,
            pkg: `nutrition.${nEv.kind}`,
            app: "Nutriție",
            // water events (desk button) have no calories: name is the headline, text the running total
            title: nEv.kind !== "meal" ? "Coach" : nEv.calories === undefined ? nEv.name : `${nEv.name} salvată`,
            text:
              nEv.kind !== "meal" || nEv.calories === undefined
                ? (nEv.text ?? "")
                : `${Math.round(nEv.calories)} kcal · ${({ breakfast: "mic dejun", lunch: "prânz", dinner: "cină", snack: "gustare" } as Record<string, string>)[nEv.mealType ?? ""] ?? ""}${nutrition ? ` · rămas ${nutrition.remaining.calories} kcal` : ""}`,
            ongoing: false,
            group: false,
            color: nEv.calories === undefined && nEv.kind === "meal" ? "#38bdf8" : "#10b981",
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
