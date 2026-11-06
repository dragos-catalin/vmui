import { houseDevices } from "@/lib/home/house";
import { haConfig } from "@/lib/home/credentials";
import "server-only";

// A small, human-readable ring of "what just happened at home". Fed by HA's
// WebSocket (state_changed + Assist conversation events), kept in-process,
// consumed by the ESP "Activity" view and the /home page.

export type Activity = {
  at: number;
  kind: "light" | "door" | "presence" | "climate" | "media" | "voice" | "scene" | "other";
  text: string;
};

const MAX = 40;
const NAME = { get(e: string): string | undefined { return houseDevices().find((d) => d.entity === e || d.entities?.includes(e))?.name; } };

declare global {
  // eslint-disable-next-line no-var
  var __vmuiActivity__: { items: Activity[]; started: boolean } | undefined;
}

const store = (globalThis.__vmuiActivity__ ??= { items: [], started: false });

export function recentActivity(n = 8): Activity[] {
  return store.items.slice(-n).reverse();
}

export function pushActivity(a: Activity): void {
  store.items.push(a);
  if (store.items.length > MAX) store.items.splice(0, store.items.length - MAX);
}

type State = { entity_id: string; state: string; attributes: Record<string, unknown> };

function friendly(s: State): string {
  return NAME.get(s.entity_id) ?? (s.attributes.friendly_name as string | undefined) ?? s.entity_id.split(".")[1]!.replace(/_/g, " ");
}

function describe(oldS: State | null, s: State): Activity | null {
  const [domain] = s.entity_id.split(".");
  const name = friendly(s);
  const was = oldS?.state;
  if (was === s.state) return null;
  if (s.state === "unavailable" || s.state === "unknown") return null;
  switch (domain) {
    case "light":
      return { at: Date.now(), kind: "light", text: `${name} ${s.state === "on" ? "aprins" : "stins"}` };
    case "binary_sensor": {
      const cls = s.attributes.device_class;
      if (cls === "door" || cls === "opening" || cls === "window") return { at: Date.now(), kind: "door", text: `${name} ${s.state === "on" ? "deschis" : "inchis"}` };
      if (cls === "occupancy" || cls === "motion" || cls === "presence") return { at: Date.now(), kind: "presence", text: `${name}: ${s.state === "on" ? "prezenta" : "liber"}` };
      return null;
    }
    case "climate":
      return { at: Date.now(), kind: "climate", text: `${name} -> ${s.state}${s.attributes.temperature ? ` ${s.attributes.temperature}*` : ""}` };
    case "media_player":
      if (!["playing", "paused", "off", "idle"].includes(s.state)) return null;
      return { at: Date.now(), kind: "media", text: `${name}: ${s.state}${s.state === "playing" && s.attributes.media_title ? ` ${String(s.attributes.media_title).slice(0, 24)}` : ""}` };
    case "switch":
      return { at: Date.now(), kind: "other", text: `${name} ${s.state === "on" ? "pornit" : "oprit"}` };
    case "script":
      return s.state === "on" ? { at: Date.now(), kind: "scene", text: `scena: ${name}` } : null;
    default:
      return null;
  }
}

/**
 * Long-lived subscriber. Idempotent; safe to call from any route. Uses HA's
 * WebSocket so we also see Assist ("Google Nest" / satellite) conversations,
 * which never appear as entity state changes.
 */
export function ensureActivityFeed(): void {
  if (store.started) return;
  const c = haConfig();
  if (!c) return;
  store.started = true;
  const connect = () => {
    const ws = new WebSocket(c.url.replace(/^http/, "ws") + "/api/websocket");
    let id = 1;
    ws.onmessage = (ev) => {
      try {
        handle(ev);
      } catch (err) {
        console.error("[vmui] activity feed message failed", err);
      }
    };
    const handle = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as {
        type: string;
        event?: { event_type?: string; data?: Record<string, unknown> };
      };
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: c.token }));
      else if (m.type === "auth_ok") {
        ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "state_changed" }));
        // Fired by assist_pipeline when a voice/text request finishes.
        ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "assist_pipeline_end" }));
        ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "conversation_processed" }));
        // Buttons on the companion-app notifications (intercom "Răspunde și deschide" / "Ignoră").
        ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "mobile_app_notification_action" }));
      } else if (m.type === "event" && m.event) {
        const d = m.event.data ?? {};
        if (m.event.event_type === "state_changed") {
          // new_state is null when an entity is removed — that crashed the
          // whole server (uncaughtException in a ws callback) on 2026-09-15.
          const ns = d.new_state as State | null | undefined;
          if (ns) {
            const a = describe((d.old_state as State | null) ?? null, ns);
            if (a) pushActivity(a);
          }
        } else if (m.event.event_type === "mobile_app_notification_action") {
          const action = String(d.action ?? "");
          // buttons on a vmui card that fell back to the HA Companion app: NOTIFY_<cardId>_<actionId>
          const nm = /^NOTIFY_([a-f0-9]{16})_(.+)$/.exec(action);
          if (nm) {
            void import("@/lib/notify/actions").then((n) => n.runAction(nm[1]!, nm[2]!, "telefon (HA)")).catch((e) => console.error("[vmui] notify action failed", e));
          } else if (action.startsWith("INTERCOM_")) {
            // lazy import: intercom.ts imports this module for pushActivity
            void import("@/lib/home/intercom").then(async (ic) => {
              if (action === "INTERCOM_OPEN") {
                const r = await ic.openDoor("telefon");
                if (!r.ok) console.warn("[vmui] intercom open from phone refused:", r.error);
              } else if (action === "INTERCOM_IGNORE") await ic.ignoreCall("telefon");
            }).catch((e) => console.error("[vmui] intercom action failed", e));
          }
        } else {
          // Shapes differ by version; pull whatever text is there.
          const text = (d.text as string | undefined) ?? ((d.result as Record<string, unknown> | undefined)?.speech as string | undefined) ?? JSON.stringify(d).slice(0, 60);
          const resp = ((d.result as Record<string, Record<string, Record<string, { speech?: string }>>> | undefined)?.response?.speech?.plain?.speech) ?? "";
          pushActivity({ at: Date.now(), kind: "voice", text: resp ? `"${text}" -> ${resp}` : `voce: ${text}` });
        }
      }
    };
    const retry = () => setTimeout(connect, 5000).unref();
    ws.onclose = retry;
    ws.onerror = () => ws.close();
  };
  connect();
}
