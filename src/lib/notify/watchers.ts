import { ownerActor } from "@/lib/home/access";
import { haConfig } from "@/lib/home/credentials";
import { ha } from "@/lib/home/ha-client";
import { nutritionSummary } from "@/lib/nutrition/summary";
import { execFile } from "node:child_process";
import "server-only";
import { IS_LINUX } from "@/lib/runtime-os";
import { msg } from "./i18n";
import { dismissByTag, notify } from "./index";
import { loadNotifySettings } from "./settings";

// Periodic sources that have no event of their own. Idempotent; started from
// the turzx state route (hot every second) and the display state route.
// Each check keeps a tiny memory so a condition notifies once and the card is
// dismissed when it clears.

type W = { started: boolean; last: Record<string, unknown> };
const w: W = ((globalThis as { __vmuiNotifyWatch__?: W }).__vmuiNotifyWatch__ ??= { started: false, last: {} });

// Watched HA sensors → the `{sensor, select, …}` branch in messages/notify cards.door/window/presence.
const SENSOR: Record<string, "mainDoor" | "window" | "presence"> = {
  "binary_sensor.main_door_door": "mainDoor",
  "binary_sensor.window_sensor_door": "window",
};

const liters = (ml: number, digits: number) => (ml / 1000).toFixed(digits).replace(/\.?0+$/, "");

export function ensureNotifyWatchers(): void {
  if (w.started) return;
  w.started = true;
  const every = (ms: number, fn: () => Promise<void>) => {
    const t = setInterval(() => fn().catch((e) => console.warn("[vmui] notify watcher", e)), ms);
    t.unref();
    void fn().catch(() => undefined);
  };
  every(5 * 60_000, water);
  every(60_000, pcAgent);
  if (IS_LINUX) every(120_000, pi);
  every(10 * 60_000, batteries);
  haEvents();
}

// ---------------------------------------------------------------- water pace

async function water() {
  const s = await loadNotifySettings();
  if (!s.waterNudgeMl) return;
  // Phone nudges go to the owner, so pace is measured against their journal.
  const o = await ownerActor().catch(() => null);
  const n = await nutritionSummary(o && o.userId !== "solo" ? { userId: o.userId, isOwner: true } : null).catch(() => null);
  if (!n?.water) return;
  const { ml, targetMl, underPace } = n.water;
  const hour = new Date().getHours();
  const expected = Math.round(targetMl * Math.min(1, Math.max(0, (hour - 7) / 15)));
  const behind = expected - ml;
  if (underPace && behind >= s.waterNudgeMl) {
    await notify({
      kind: "water",
      tag: "water-pace",
      title: msg("cards.water.title", { l: liters(behind, 1) }),
      body: msg("cards.water.body", { ml: liters(ml, 2), target: (targetMl / 1000).toFixed(1) }),
      progress: Math.round((ml / Math.max(1, targetMl)) * 100),
      priority: "default",
      ttlSec: 3 * 3600,
      noFallback: true,
      actions: [
        { id: "add250", label: msg("cards.water.add", { ml: 250 }), style: "primary", body: { ml: 250 } },
        { id: "add500", label: msg("cards.water.add", { ml: 500 }), style: "ghost", body: { ml: 500 } },
      ],
      data: { ml, targetMl },
    });
  } else if (!underPace) {
    await dismissByTag("water-pace", "water");
  }
}

// ---------------------------------------------------------------- PC agent (only meaningful on the Pi, where the sensor lives)

/** Offline samples (60 s apart) before the card fires: sleep/wake and agent restarts flap for a minute. */
export const PC_OFFLINE_SAMPLES = 2;
export type PcWatch = { online?: boolean; offN: number };

/** Confirmed state + consecutive offline count → next state and the edge to act on. First sample never fires. */
export function pcStep(st: PcWatch, online: boolean): { st: PcWatch; edge: "offline" | "online" | null } {
  if (online) return { st: { online: true, offN: 0 }, edge: st.online === false ? "online" : null };
  const offN = st.offN + 1;
  if (st.online === undefined) return { st: { online: false, offN }, edge: null };
  if (st.online && offN >= PC_OFFLINE_SAMPLES) return { st: { online: false, offN }, edge: "offline" };
  return { st: { online: st.online, offN }, edge: null };
}

async function pcAgent() {
  if (!haConfig()) return;
  const s = await ha.state("sensor.vmui_pc_agent").catch(() => null);
  const a = (s?.attributes ?? {}) as Record<string, unknown>;
  const seen = typeof a.at === "number" ? a.at : 0;
  const online = s?.state === "online" && Date.now() / 1000 - seen < 120;
  const { st, edge } = pcStep((w.last.pc as PcWatch | undefined) ?? { offN: 0 }, online);
  w.last.pc = st;
  if (edge === "offline") {
    // the PC itself may just be asleep — say so and offer wake
    await notify({
      kind: "pc",
      tag: "pc-agent",
      title: msg("cards.pc.title"),
      body: msg("cards.pc.body"),
      priority: "default",
      ttlSec: 6 * 3600,
      noFallback: true,
      actions: [{ id: "wake", label: msg("cards.pc.wake"), style: "primary" }],
    });
  } else if (edge === "online") {
    await dismissByTag("pc-agent", "pc");
  }
}

// ---------------------------------------------------------------- Pi health (runs on the Pi)

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (_e, out, err) => res(String(out || err || "").trim())));
}

async function pi() {
  const [thr, temp, active] = await Promise.all([run("vcgencmd", ["get_throttled"]), run("vcgencmd", ["measure_temp"]), run("systemctl", ["is-active", "turzx", "desk-button", "hub-cast", "docker"])]);
  const flags = parseInt(thr.split("=")[1] ?? "0", 16);
  const undervoltNow = (flags & 0x1) !== 0;
  const t = Number((temp.match(/([\d.]+)/) ?? [])[1] ?? NaN);
  if (undervoltNow || t > 75) {
    await notify({
      kind: "pi",
      tag: "pi-health",
      title: undervoltNow ? msg("cards.pi.undervoltTitle") : msg("cards.pi.tempTitle", { temp: t.toFixed(0) }),
      body: undervoltNow ? msg("cards.pi.undervoltBody", { flags: thr.split("=")[1] ?? "?" }) : msg("cards.pi.tempBody"),
      priority: "default",
      ttlSec: 2 * 3600,
      noFallback: true,
      data: { throttled: thr, tempC: t },
    });
  } else {
    await dismissByTag("pi-health", "pi");
  }
  const units = ["turzx", "desk-button", "hub-cast", "docker"];
  const states = active.split("\n");
  const down = units.filter((_, i) => states[i] !== "active" && states[i] !== undefined);
  const key = down.join(",");
  if (down.length && w.last.piDown !== key) {
    await notify({
      kind: "pi",
      tag: "pi-units",
      title: msg("cards.pi.unitsTitle", { count: down.length }),
      body: down.join(", "),
      priority: "high",
      ttlSec: 6 * 3600,
      actions: down.slice(0, 2).map((u) => ({ id: `restart-${u}`, label: msg("cards.pi.restart", { unit: u }), style: "primary" as const, body: { unit: u } })),
      data: { down },
    });
  } else if (!down.length && w.last.piDown) {
    await dismissByTag("pi-units", "pi");
  }
  w.last.piDown = key;
}

// ---------------------------------------------------------------- batteries (Tuya sensors via HA)

async function batteries() {
  if (!haConfig()) return;
  const s = await loadNotifySettings();
  const states = await ha.states().catch(() => []);
  const low = states.filter((x) => x.entity_id.startsWith("sensor.") && x.attributes.device_class === "battery" && Number(x.state) <= s.batteryBelow && Number.isFinite(Number(x.state)));
  for (const x of low) {
    const name = String(x.attributes.friendly_name ?? x.entity_id).replace(/ battery$/i, "");
    await notify({ kind: "battery", tag: `battery-${x.entity_id}`, title: msg("cards.battery.title", { name, pct: Number(x.state) }), body: msg("cards.battery.body"), priority: "low", ttlSec: 24 * 3600, noFallback: true, data: { entity: x.entity_id, pct: Number(x.state) } });
  }
}

// ---------------------------------------------------------------- door / window / presence (HA websocket, state edges)

function haEvents() {
  const c = haConfig();
  if (!c) return;
  const connect = () => {
    const ws = new WebSocket(c.url.replace(/^http/, "ws") + "/api/websocket");
    let id = 1;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string; event?: { event_type?: string; data?: { entity_id?: string; old_state?: { state: string } | null; new_state?: { state: string; attributes: Record<string, unknown> } | null } } };
        if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: c.token }));
        else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "state_changed" }));
        else if (m.type === "event" && m.event?.event_type === "state_changed") {
          const d = m.event.data ?? {};
          const ns = d.new_state;
          const eid = d.entity_id ?? "";
          if (!ns || !(eid in SENSOR) || d.old_state?.state === ns.state) return;
          void onSensor(eid, ns.state, d.old_state?.state);
        }
      } catch (e) {
        console.warn("[vmui] notify ha ws", e);
      }
    };
    ws.onclose = () => setTimeout(connect, 5000).unref();
    ws.onerror = () => ws.close();
  };
  connect();
}

async function onSensor(eid: string, state: string, was: string | undefined) {
  if (was === undefined || state === "unavailable" || state === "unknown") return;
  const sensor = SENSOR[eid] ?? eid;
  const hour = new Date().getHours();
  const night = hour >= 23 || hour < 7;
  if (eid.includes("door")) {
    if (state === "on") {
      await notify({ kind: "door", tag: `door-${eid}`, title: msg("cards.door.title", { sensor }), body: night ? msg("cards.door.night") : "", priority: night ? "high" : "default", ttlSec: 1800, noFallback: !night, actions: [{ id: "light_on", label: msg("cards.door.lightOn"), style: "ghost", body: { entity: "light.main_light" } }], data: { entity: eid } });
    } else await dismissByTag(`door-${eid}`, "door");
  } else if (eid.includes("window")) {
    if (state === "on") {
      await notify({ kind: "window", tag: `window-${eid}`, title: msg("cards.window.title", { sensor }), body: "", priority: "low", ttlSec: 6 * 3600, noFallback: true, data: { entity: eid } });
    } else await dismissByTag(`window-${eid}`, "window");
  } else if (eid.includes("presence") || eid.includes("occupancy")) {
    // only worth a card when nobody should be home
    const away = await ha.state("person.dragos").then((p) => p.state !== "home").catch(() => false);
    if (state === "on" && away) {
      await notify({ kind: "presence", tag: "presence-away", title: msg("cards.presence.title"), body: msg("cards.presence.body", { sensor }), priority: "urgent", ttlSec: 3600, force: true, actions: [{ id: "lights_off", label: msg("cards.presence.lightsOff"), style: "danger" }], data: { entity: eid } });
    }
  }
}
