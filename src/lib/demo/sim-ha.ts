import { EventEmitter } from "node:events";
import type { HaForecast, HaState } from "@/lib/home/ha-client";

// In-process simulated Home Assistant for the demo hub (P10-04, VATRA_DEMO=1). ha-client routes
// rest() / haWsCommands() / haStateChanges() here, so every hub feature runs without HA_URL.
// The house is deterministic: 4 rooms, lights (2 RGB), an AC, the front door lock + intercom
// doorbell, climate sensors, weather with forecast, persons and the scripts the hub calls.
// Service calls mutate state and emit state_changed; the only autonomous change is a gentle
// temperature drift every few minutes. Nothing rings on its own.

type Attrs = Record<string, unknown>;
type Area = { area_id: string; name: string };
type Device = { id: string; name: string | null; name_by_user: string | null; area_id: string | null; manufacturer: string | null; model: string | null; entry_type: string | null; disabled_by: string | null };
type Entity = { entity_id: string; device_id: string | null; area_id: string | null; disabled_by: string | null; hidden_by: string | null; entity_category: string | null };

export const SIM_AREAS: Area[] = [
  { area_id: "living_room", name: "Living room" },
  { area_id: "kitchen", name: "Kitchen" },
  { area_id: "bedroom", name: "Bedroom" },
  { area_id: "hallway", name: "Hallway" },
];

type Seed = { entity: string; state: string; attrs: Attrs; area?: string; device?: { name: string; model: string } };

const RGB_LIGHT = { supported_color_modes: ["rgb"], color_mode: "rgb" };
const DIM_LIGHT = { supported_color_modes: ["brightness"], color_mode: "brightness" };
const temp = (name: string, v: number): Attrs => ({ friendly_name: name, device_class: "temperature", unit_of_measurement: "°C", state_class: "measurement", base: v });
const hum = (name: string, v: number): Attrs => ({ friendly_name: name, device_class: "humidity", unit_of_measurement: "%", state_class: "measurement", base: v });

const SEEDS: Seed[] = [
  { entity: "light.living_room", state: "on", attrs: { friendly_name: "Living room light", ...RGB_LIGHT, brightness: 180, rgb_color: [255, 180, 110] }, area: "living_room", device: { name: "Living room light", model: "RGB bulb" } },
  { entity: "light.floor_lamp", state: "off", attrs: { friendly_name: "Floor lamp", ...DIM_LIGHT }, area: "living_room", device: { name: "Floor lamp", model: "Dimmable bulb" } },
  { entity: "climate.living_room_ac", state: "cool", attrs: { friendly_name: "Air conditioner", hvac_modes: ["off", "cool", "heat", "dry", "fan_only", "auto"], fan_modes: ["auto", "low", "medium", "high"], fan_mode: "auto", min_temp: 16, max_temp: 30, target_temp_step: 0.5, temperature: 23, current_temperature: 24.2 }, area: "living_room", device: { name: "Air conditioner", model: "Split AC" } },
  { entity: "sensor.living_room_temperature", state: "22.8", attrs: temp("Living room temperature", 22.8), area: "living_room", device: { name: "Living room climate sensor", model: "TH sensor" } },
  { entity: "sensor.living_room_humidity", state: "46", attrs: hum("Living room humidity", 46), area: "living_room" },
  { entity: "light.kitchen", state: "off", attrs: { friendly_name: "Kitchen light", ...DIM_LIGHT }, area: "kitchen", device: { name: "Kitchen light", model: "Dimmable bulb" } },
  { entity: "sensor.kitchen_temperature", state: "23.4", attrs: temp("Kitchen temperature", 23.4), area: "kitchen", device: { name: "Kitchen sensor", model: "TH sensor" } },
  { entity: "light.bedroom", state: "off", attrs: { friendly_name: "Bedroom light", ...RGB_LIGHT }, area: "bedroom", device: { name: "Bedroom light", model: "RGB bulb" } },
  { entity: "sensor.bedroom_temperature", state: "21.6", attrs: temp("Bedroom temperature", 21.6), area: "bedroom", device: { name: "Bedroom climate sensor", model: "TH sensor" } },
  { entity: "sensor.bedroom_humidity", state: "51", attrs: hum("Bedroom humidity", 51), area: "bedroom" },
  { entity: "light.hallway", state: "off", attrs: { friendly_name: "Hallway light", ...DIM_LIGHT }, area: "hallway", device: { name: "Hallway light", model: "Dimmable bulb" } },
  { entity: "lock.front_door", state: "locked", attrs: { friendly_name: "Front door" }, area: "hallway", device: { name: "Front door lock", model: "Smart lock" } },
  { entity: "binary_sensor.intercom_doorbell", state: "off", attrs: { friendly_name: "Intercom doorbell", device_class: "sound" }, area: "hallway", device: { name: "Intercom", model: "Doorbell" } },
  { entity: "weather.home", state: "partlycloudy", attrs: { friendly_name: "Home", temperature: 14, humidity: 62, pressure: 1016, wind_speed: 11, temperature_unit: "°C", wind_speed_unit: "km/h" } },
  { entity: "person.alex", state: "home", attrs: { friendly_name: "Alex" } },
  { entity: "person.sam", state: "not_home", attrs: { friendly_name: "Sam" } },
  { entity: "calendar.family", state: "off", attrs: { friendly_name: "Family" } },
  { entity: "todo.shopping_list", state: "3", attrs: { friendly_name: "Shopping list" } },
];

/** Script names the hub calls (ambilight modes, stream scenes, flashes, copilot); any other name also succeeds. */
export const SIM_SCRIPTS = [
  "ambilight_all", "movie_mode_on", "movie_mode_off", "music_mode", "notify_flash", "copilot_snapshot", "stream_flash",
  "stream_scene_party", "stream_scene_calm", "stream_scene_red_alert", "stream_scene_gift_gold", "stream_scene_rainbow", "stream_scene_blackout_flash", "stream_scene_default",
];

const SHOPPING = ["Milk", "Coffee beans", "Lemons"];

type Sim = { states: Map<string, HaState>; bus: EventEmitter; drift: NodeJS.Timeout | null; driftTick: number };
const g = globalThis as { __vatraSimHa__?: Sim };

function fresh(): Sim {
  const now = new Date().toISOString();
  const states = new Map<string, HaState>();
  for (const s of SEEDS) states.set(s.entity, { entity_id: s.entity, state: s.state, attributes: { ...withoutBase(s.attrs) }, last_changed: now, last_updated: now });
  for (const name of SIM_SCRIPTS) states.set(`script.${name}`, { entity_id: `script.${name}`, state: "off", attributes: { friendly_name: name.replace(/_/g, " ") }, last_changed: now, last_updated: now });
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  return { states, bus, drift: null, driftTick: 0 };
}

function withoutBase(a: Attrs): Attrs {
  const { base: _b, ...rest } = a;
  return rest;
}

function sim(): Sim {
  const s = (g.__vatraSimHa__ ??= fresh());
  if (!s.drift) {
    s.drift = setInterval(() => drift(s), 3 * 60_000);
    s.drift.unref();
  }
  return s;
}

/** Back to the seeded house (tests; a demo container restarts instead). */
export function resetSim(): void {
  if (g.__vatraSimHa__?.drift) clearInterval(g.__vatraSimHa__.drift);
  g.__vatraSimHa__ = undefined;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function put(s: Sim, entityId: string, state: string, attrs: Attrs): HaState {
  const old = s.states.get(entityId);
  const now = new Date().toISOString();
  const next: HaState = {
    entity_id: entityId,
    state,
    attributes: attrs,
    last_changed: old && old.state === state ? old.last_changed : now,
    last_updated: now,
  };
  s.states.set(entityId, next);
  s.bus.emit("state_changed", clone(next));
  return next;
}

/** Deterministic drift: each sensor follows a slow sine around its seed, ±0.6 °C / ±3 %. */
function drift(s: Sim): void {
  s.driftTick++;
  SEEDS.forEach((seed, i) => {
    const base = seed.attrs.base;
    if (typeof base !== "number") return;
    const cur = s.states.get(seed.entity);
    if (!cur) return;
    const amp = seed.attrs.device_class === "humidity" ? 3 : 0.6;
    const v = base + amp * Math.sin((s.driftTick + i * 7) / 9);
    put(s, seed.entity, seed.attrs.device_class === "humidity" ? String(Math.round(v)) : v.toFixed(1), cur.attributes);
  });
  const ac = s.states.get("climate.living_room_ac");
  const room = Number(s.states.get("sensor.living_room_temperature")?.state ?? 23);
  if (ac) put(s, ac.entity_id, ac.state, { ...ac.attributes, current_temperature: Number((room + (ac.state === "off" ? 0.8 : 0.3)).toFixed(1)) });
}

/** Ring the intercom on demand (demo walkthrough), off again after 5 s. */
export function simRingDoorbell(): void {
  const s = sim();
  const cur = s.states.get("binary_sensor.intercom_doorbell");
  if (!cur) return;
  put(s, cur.entity_id, "on", cur.attributes);
  setTimeout(() => put(s, cur.entity_id, "off", cur.attributes), 5_000).unref();
}

// ---------------------------------------------------------------- services

const targets = (data: Attrs): string[] => {
  const e = data.entity_id;
  if (typeof e === "string") return e.split(",").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(e)) return e.filter((x): x is string => typeof x === "string");
  return [];
};

function lightOn(s: Sim, cur: HaState, data: Attrs): HaState {
  const a: Attrs = { ...cur.attributes };
  const pct = typeof data.brightness_pct === "number" ? data.brightness_pct : null;
  const bri = typeof data.brightness === "number" ? data.brightness : pct !== null ? Math.round((pct / 100) * 255) : typeof a.brightness === "number" ? a.brightness : 200;
  a.brightness = Math.max(1, Math.min(255, Math.round(bri)));
  const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
  if (modes.includes("rgb")) {
    if (Array.isArray(data.rgb_color) && data.rgb_color.length === 3) a.rgb_color = data.rgb_color.map((n) => Math.max(0, Math.min(255, Number(n) || 0)));
    else a.rgb_color ??= [255, 200, 150];
  }
  if (pct === 0 || data.brightness === 0) return lightOff(s, cur);
  return put(s, cur.entity_id, "on", a);
}

function lightOff(s: Sim, cur: HaState): HaState {
  const { brightness: _b, rgb_color: _c, ...a } = cur.attributes;
  return put(s, cur.entity_id, "off", a);
}

function climate(s: Sim, cur: HaState, service: string, data: Attrs): HaState | null {
  const a: Attrs = { ...cur.attributes };
  switch (service) {
    case "turn_on":
      return put(s, cur.entity_id, cur.state === "off" ? "cool" : cur.state, a);
    case "turn_off":
      return put(s, cur.entity_id, "off", a);
    case "toggle":
      return put(s, cur.entity_id, cur.state === "off" ? "cool" : "off", a);
    case "set_temperature": {
      if (typeof data.temperature === "number") a.temperature = Math.max(16, Math.min(30, data.temperature));
      const mode = typeof data.hvac_mode === "string" ? data.hvac_mode : cur.state === "off" ? "cool" : cur.state;
      return put(s, cur.entity_id, mode, a);
    }
    case "set_hvac_mode":
      return put(s, cur.entity_id, typeof data.hvac_mode === "string" ? data.hvac_mode : cur.state, a);
    case "set_fan_mode":
      if (typeof data.fan_mode === "string") a.fan_mode = data.fan_mode;
      return put(s, cur.entity_id, cur.state, a);
    default:
      return null;
  }
}

function onOff(s: Sim, cur: HaState, service: string): HaState | null {
  if (service === "turn_on") return put(s, cur.entity_id, "on", cur.attributes);
  if (service === "turn_off") return put(s, cur.entity_id, "off", cur.attributes);
  if (service === "toggle") return put(s, cur.entity_id, cur.state === "on" ? "off" : "on", cur.attributes);
  return null;
}

function lock(s: Sim, cur: HaState, service: string): HaState | null {
  if (service === "lock" || service === "turn_on") return put(s, cur.entity_id, "locked", cur.attributes);
  if (service === "unlock" || service === "open" || service === "turn_off") return put(s, cur.entity_id, "unlocked", cur.attributes);
  if (service === "toggle") return put(s, cur.entity_id, cur.state === "locked" ? "unlocked" : "locked", cur.attributes);
  return null;
}

const SCENE_COLORS: Record<string, [number, number, number]> = {
  stream_scene_party: [255, 0, 200],
  stream_scene_calm: [90, 60, 200],
  stream_scene_red_alert: [255, 0, 0],
  stream_scene_gift_gold: [255, 180, 0],
  stream_scene_rainbow: [0, 120, 255],
};
const RGB_LIGHTS = ["light.living_room", "light.bedroom"];

/** Scripts flip on, apply a visible effect on the RGB lights where it makes sense, then report off. */
function runScript(s: Sim, name: string): HaState[] {
  const id = `script.${name}`;
  const cur = s.states.get(id) ?? { entity_id: id, state: "off", attributes: { friendly_name: name }, last_changed: "", last_updated: "" };
  const changed: HaState[] = [put(s, id, "on", cur.attributes)];
  const light = (e: string, data: Attrs | null) => {
    const l = s.states.get(e);
    if (l) changed.push(data ? lightOn(s, l, data) : lightOff(s, l));
  };
  const color = SCENE_COLORS[name];
  if (color) RGB_LIGHTS.forEach((e) => light(e, { rgb_color: color, brightness: 230 }));
  else if (name === "movie_mode_on") light("light.living_room", { brightness: 40, rgb_color: [80, 60, 200] });
  else if (name === "movie_mode_off" || name === "stream_scene_default") light("light.living_room", { brightness: 153, rgb_color: [255, 180, 110] });
  else if (name === "stream_scene_blackout_flash") RGB_LIGHTS.forEach((e) => light(e, null));
  changed.push(put(s, id, "off", cur.attributes));
  return changed;
}

function forecast(type: "daily" | "hourly"): HaForecast[] {
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  if (type === "daily") start.setUTCHours(12);
  const conditions = ["sunny", "partlycloudy", "cloudy", "rainy", "partlycloudy", "sunny", "windy"];
  const n = type === "daily" ? 7 : 24;
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(start.getTime() + i * (type === "daily" ? 86_400_000 : 3_600_000));
    const wave = Math.sin((t.getUTCHours() - 9) / 24 * 2 * Math.PI);
    const base = type === "daily" ? 15 + (i % 3) : 13 + 4 * wave;
    return {
      datetime: t.toISOString(),
      condition: conditions[(t.getUTCDate() + (type === "hourly" ? Math.floor(i / 6) : i)) % conditions.length] ?? "cloudy",
      temperature: Number(base.toFixed(1)),
      ...(type === "daily" ? { templow: Number((base - 7).toFixed(1)) } : {}),
      precipitation: i % 4 === 3 ? 1.2 : 0,
      precipitation_probability: i % 4 === 3 ? 60 : 10,
      wind_speed: 8 + (i % 5) * 2,
    };
  });
}

function callService(s: Sim, domain: string, service: string, data: Attrs, returnResponse: boolean): unknown {
  if (domain === "weather" && service === "get_forecasts") {
    const type = data.type === "hourly" ? "hourly" : "daily";
    const ids = targets(data).length ? targets(data) : ["weather.home"];
    const service_response = Object.fromEntries(ids.map((id) => [id, { forecast: forecast(type) }]));
    return returnResponse ? { changed_states: [], service_response } : service_response;
  }
  if (domain === "todo" && service === "get_items") {
    const items = SHOPPING.map((summary, i) => ({ summary, uid: `demo-${i}`, status: "needs_action" }));
    return Object.fromEntries((targets(data).length ? targets(data) : ["todo.shopping_list"]).map((id) => [id, { items }]));
  }
  if (domain === "script") {
    if (service === "turn_on") return targets(data).flatMap((e) => runScript(s, e.replace(/^script\./, ""))).map(clone);
    if (service === "turn_off" || service === "reload") return [];
    return runScript(s, service).map(clone);
  }
  const changed: HaState[] = [];
  for (const id of targets(data)) {
    const cur = s.states.get(id);
    if (!cur) continue;
    const d = id.split(".")[0];
    let r: HaState | null = null;
    if (d === "light" && (domain === "light" || domain === "homeassistant")) {
      if (service === "turn_on") r = lightOn(s, cur, data);
      else if (service === "turn_off") r = lightOff(s, cur);
      else if (service === "toggle") r = cur.state === "on" ? lightOff(s, cur) : lightOn(s, cur, data);
    } else if (d === "climate" && (domain === "climate" || domain === "homeassistant")) r = climate(s, cur, service, data);
    else if (d === "lock" && (domain === "lock" || domain === "homeassistant")) r = lock(s, cur, service);
    else if ((d === "switch" || d === "input_boolean" || d === "fan") && (domain === d || domain === "homeassistant")) r = onOff(s, cur, service);
    if (r) changed.push(r);
  }
  // mqtt.publish, tts.*, cast.*, notify.*, select.* and friends: accepted, nothing to simulate
  return changed.map(clone);
}

// ---------------------------------------------------------------- history / calendar

function history(entityId: string, since: Date): HaState[][] {
  const s = sim();
  const cur = s.states.get(entityId);
  if (!cur) return [];
  const seed = SEEDS.find((x) => x.entity === entityId);
  const base = seed?.attrs.base;
  const now = Date.now();
  const from = Math.max(since.getTime(), now - 7 * 86_400_000);
  if (typeof base !== "number") return [[{ ...clone(cur), last_changed: new Date(from).toISOString(), last_updated: new Date(from).toISOString() }]];
  const amp = seed?.attrs.device_class === "humidity" ? 3 : 0.6;
  const rows: HaState[] = [];
  for (let t = from; t < now; t += 30 * 60_000) {
    const v = base + amp * Math.sin(t / 3_600_000 / 4);
    const iso = new Date(t).toISOString();
    rows.push({ entity_id: entityId, state: seed?.attrs.device_class === "humidity" ? String(Math.round(v)) : v.toFixed(1), attributes: {}, last_changed: iso, last_updated: iso });
  }
  rows.push({ ...clone(cur), attributes: {} });
  return [rows];
}

function calendar(start: Date, end: Date) {
  const out: Array<{ summary: string; start: { dateTime: string }; end: { dateTime: string }; location?: string }> = [];
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const plan: Array<[string, number, number, string?]> = [
    ["School run", 7, 1],
    ["Team standup", 9, 0.5],
    ["Groceries", 18, 1, "Market"],
  ];
  for (let d = day.getTime(); d < end.getTime() && out.length < 60; d += 86_400_000) {
    for (const [summary, h, dur, location] of plan) {
      const s = d + h * 3_600_000;
      if (s < start.getTime() || s >= end.getTime()) continue;
      out.push({ summary, start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + dur * 3_600_000).toISOString() }, ...(location ? { location } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- transports

class SimHttpError extends Error {}
const notFound = (path: string) => new SimHttpError(`HA 404 ${path}: not found`);

/** The REST surface ha-client uses, answered from the simulated house. Throws like a failed HA call. */
export async function simRest<T>(path: string, init?: RequestInit): Promise<T> {
  const s = sim();
  const method = (init?.method ?? "GET").toUpperCase();
  const url = new URL(`http://sim${path}`);
  const p = decodeURIComponent(url.pathname);
  const body = (() => {
    try {
      return typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Attrs) : {};
    } catch {
      return {};
    }
  })();

  if (p === "/states" && method === "GET") return clone([...s.states.values()]) as T;
  const st = /^\/states\/(.+)$/.exec(p);
  if (st?.[1]) {
    const id = st[1];
    if (method === "GET") {
      const cur = s.states.get(id);
      if (!cur) throw notFound(path);
      return clone(cur) as T;
    }
    if (method === "POST") {
      const attrs = typeof body.attributes === "object" && body.attributes !== null ? (body.attributes as Attrs) : {};
      return clone(put(s, id, String(body.state ?? "unknown"), attrs)) as T;
    }
  }
  const sv = /^\/services\/([a-z_]+)\/([a-z0-9_]+)$/.exec(p);
  if (sv?.[1] && sv[2] && method === "POST") return callService(s, sv[1], sv[2], body, url.searchParams.has("return_response")) as T;
  const ev = /^\/events\/(.+)$/.exec(p);
  if (ev?.[1] && method === "POST") return { message: `Event ${ev[1]} fired.` } as T;
  const hi = /^\/history\/period\/(.+)$/.exec(p);
  if (hi?.[1] && method === "GET") {
    const since = new Date(hi[1]);
    return history(url.searchParams.get("filter_entity_id") ?? "", Number.isNaN(since.getTime()) ? new Date(Date.now() - 86_400_000) : since) as T;
  }
  const ca = /^\/calendars\/(.+)$/.exec(p);
  if (ca?.[1] && method === "GET") {
    if (!s.states.has(ca[1])) throw notFound(path);
    const start = new Date(url.searchParams.get("start") ?? Date.now());
    const end = new Date(url.searchParams.get("end") ?? Date.now() + 86_400_000);
    return calendar(start, end) as T;
  }
  if (p.startsWith("/config/config_entries/flow")) {
    if (method === "DELETE") return {} as T;
    return { type: "abort", flow_id: "demo", reason: "demo" } as T;
  }
  if (p === "/" || p === "/config") return { message: "API running.", version: "demo", location_name: "Vatra demo" } as T;
  throw notFound(path);
}

const devId = (entity: string) => `dev_${entity.replace(/[^a-z0-9]+/g, "_")}`;

function registries(): { devices: Device[]; entities: Entity[] } {
  const devices: Device[] = [];
  const entities: Entity[] = [];
  let lastDevice: string | null = null;
  for (const seed of SEEDS) {
    if (seed.device) {
      lastDevice = devId(seed.entity);
      devices.push({ id: lastDevice, name: seed.device.name, name_by_user: null, area_id: seed.area ?? null, manufacturer: "Vatra demo", model: seed.device.model, entry_type: null, disabled_by: null });
    }
    // sensors without their own device (humidity) belong to the climate sensor before them
    const device = seed.device ? lastDevice : seed.area ? lastDevice : null;
    entities.push({ entity_id: seed.entity, device_id: device, area_id: seed.area ?? null, disabled_by: null, hidden_by: null, entity_category: null });
  }
  for (const name of SIM_SCRIPTS) entities.push({ entity_id: `script.${name}`, device_id: null, area_id: null, disabled_by: null, hidden_by: null, entity_category: null });
  return { devices, entities };
}

/** WebSocket-only commands (registries, get_states) in request order. */
export async function simWsCommands<T extends unknown[]>(types: string[]): Promise<T> {
  const s = sim();
  const reg = registries();
  return types.map((type) => {
    switch (type) {
      case "config/area_registry/list":
        return clone(SIM_AREAS);
      case "config/device_registry/list":
        return clone(reg.devices);
      case "config/entity_registry/list":
        return clone(reg.entities);
      case "get_states":
        return clone([...s.states.values()]);
      case "get_config":
        return { location_name: "Vatra demo", time_zone: "Europe/Bucharest", version: "demo", unit_system: { temperature: "°C" } };
      default:
        throw new Error(`HA ${type}: unknown command`);
    }
  }) as T;
}

/** state_changed stream, same contract as the real WebSocket subscription. */
export async function* simStateChanges(signal: AbortSignal): AsyncGenerator<HaState> {
  const s = sim();
  const queue: HaState[] = [];
  let wake: (() => void) | null = null;
  const onChange = (st: HaState) => {
    queue.push(st);
    wake?.();
  };
  const onAbort = () => wake?.();
  s.bus.on("state_changed", onChange);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = null;
      while (queue.length && !signal.aborted) yield queue.shift()!;
    }
  } finally {
    s.bus.off("state_changed", onChange);
    signal.removeEventListener("abort", onAbort);
  }
}
