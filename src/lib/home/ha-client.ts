import "server-only";
import { haConfig } from "./credentials";

export type HaState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
};

export class HaUnavailable extends Error {
  constructor(msg = "Home Assistant is not configured (HA_URL / HA_TOKEN)") {
    super(msg);
    this.name = "HaUnavailable";
  }
}

function cfg() {
  const c = haConfig();
  if (!c) throw new HaUnavailable();
  return c;
}

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, token } = cfg();
  const res = await fetch(`${url}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    // HA answers in <50 ms on the LAN; anything slower is a stuck appliance.
    signal: init?.signal ?? AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HA ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const ha = {
  configured: () => haConfig() !== null,
  publicUrl: () => {
    const c = haConfig();
    return c?.publicDomain ? `https://${c.publicDomain}` : c?.url ?? null;
  },
  states: () => rest<HaState[]>("/states"),
  state: (entityId: string) => rest<HaState>(`/states/${entityId}`),
  /** Create/update a plain entity through the REST states API. HA owns no
   *  integration for it, so it survives until HA restarts; re-post on a timer. */
  setState: (entityId: string, state: string, attributes: Record<string, unknown> = {}) =>
    rest<HaState>(`/states/${entityId}`, { method: "POST", body: JSON.stringify({ state, attributes }) }),
  callService: (domain: string, service: string, data: Record<string, unknown>) =>
    rest<HaState[]>(`/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) }),
  /** Raw HyperHDR JSON-API commands fanned out to every instance via MQTT. */
  ambilightAll: (commands: Array<Record<string, unknown>>) =>
    rest("/services/script/ambilight_all", {
      method: "POST",
      body: JSON.stringify({ commands: JSON.stringify(commands) }),
    }),
  runScript: (name: string, data: Record<string, unknown> = {}) =>
    rest(`/services/script/${name}`, { method: "POST", body: JSON.stringify(data) }),
  /** Fire a custom event on the HA bus; automations trigger on `platform: event`. */
  fireEvent: (eventType: string, data: Record<string, unknown> = {}) =>
    rest<{ message: string }>(`/events/${encodeURIComponent(eventType)}`, { method: "POST", body: JSON.stringify(data) }),
  /** State history for one entity since `since` (ISO). Minimal response = [{s, lu}]-style compact rows. */
  history: (entityId: string, since: Date) =>
    rest<HaState[][]>(`/history/period/${since.toISOString()}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`),
  calendarEvents: (entityId: string, start: Date, end: Date) =>
    rest<Array<{ summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string }>>(
      `/calendars/${entityId}?start=${start.toISOString()}&end=${end.toISOString()}`,
    ),
  /** Daily or hourly forecast via the weather.get_forecasts service (return_response). */
  forecast: async (entityId: string, type: "daily" | "hourly") => {
    const r = await rest<{ service_response?: Record<string, { forecast?: HaForecast[] }> }>(
      `/services/weather/get_forecasts?return_response`,
      { method: "POST", body: JSON.stringify({ entity_id: entityId, type }) },
    );
    return r.service_response?.[entityId]?.forecast ?? [];
  },
};

export type HaForecast = {
  datetime: string;
  condition?: string;
  temperature?: number;
  templow?: number;
  precipitation?: number;
  precipitation_probability?: number;
  wind_speed?: number;
};

/** Server-Sent Events stream of `state_changed` from HA's WebSocket API. */
/**
 * Run WebSocket-only commands (area/device/entity registries) in one short-lived
 * connection and return each result in order. 10 s timeout for the whole batch.
 */
export async function haWsCommands<T extends unknown[]>(types: string[]): Promise<T> {
  const { url, token } = cfg();
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/api/websocket");
  return new Promise<T>((resolve, reject) => {
    const out: unknown[] = new Array(types.length);
    let pending = types.length;
    const timer = setTimeout(() => { ws.close(); reject(new Error("HA websocket timeout")); }, 10_000);
    const done = (err?: Error) => {
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (err) reject(err);
      else resolve(out as T);
    };
    ws.onerror = () => done(new Error("HA websocket error"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string } };
      if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (msg.type === "auth_invalid") done(new Error("HA token rejected"));
      else if (msg.type === "auth_ok") types.forEach((type, i) => ws.send(JSON.stringify({ id: i + 1, type })));
      else if (msg.type === "result" && msg.id) {
        if (!msg.success) return done(new Error(`HA ${types[msg.id - 1]}: ${msg.error?.message ?? "failed"}`));
        out[msg.id - 1] = msg.result;
        if (--pending === 0) done();
      }
    };
  });
}

export async function* haStateChanges(signal: AbortSignal): AsyncGenerator<HaState> {
  const { url, token } = cfg();
  const wsUrl = url.replace(/^http/, "ws") + "/api/websocket";
  const ws = new WebSocket(wsUrl);
  const queue: HaState[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; event?: { data?: { new_state?: HaState } } };
    if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
    else if (msg.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
    else if (msg.type === "event" && msg.event?.data?.new_state) {
      queue.push(msg.event.data.new_state);
      wake?.();
    }
  };
  const finish = () => {
    closed = true;
    wake?.();
  };
  ws.onclose = finish;
  ws.onerror = finish;
  signal.addEventListener("abort", () => ws.close(), { once: true });

  try {
    while (!closed) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = null;
      while (queue.length) yield queue.shift()!;
    }
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
}
