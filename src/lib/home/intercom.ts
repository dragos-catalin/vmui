import "server-only";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { listNodes, showMessage } from "@/lib/esp/gallery";
import { credential } from "@/lib/home/credentials";
import { ha } from "@/lib/home/ha-client";
import { deviceText } from "@/lib/home/device-text";

/** Electra IA02 intercom, wired to the office ESP32 (ring on GPIO34, two
 *  relays on GPIO16/17). One in-memory state: the current call and the
 *  auto-open arm. Survives HMR via globalThis like the other feeds. */
export type IntercomEvent = "ring" | "end" | "opened";

export interface IntercomState {
  /** ms epoch of the ring that started the current call; null when idle */
  ringingSince: number | null;
  /** last ring / open times for the turzx + /home cards */
  lastRingAt: number | null;
  lastOpenAt: number | null;
  /** auto-open armed until this ms epoch (courier / guest mode) */
  autoOpenUntil: number | null;
  /** ESP node that owns the relays */
  node: string;
  /** rolling log of the last 20 events */
  log: Array<{ at: number; event: IntercomEvent | "armed" | "disarmed"; by: string }>;
}

declare global {
  var __vmuiIntercom__: IntercomState | undefined;
}

const st: IntercomState = (globalThis.__vmuiIntercom__ ??= {
  ringingSince: null,
  lastRingAt: null,
  lastOpenAt: null,
  autoOpenUntil: null,
  node: "bluetooth-proxy-1",
  log: [],
});

const PHONE_TAG = "intercom-call";
const RING_TTL_MS = 60_000;

function note(event: IntercomState["log"][number]["event"], by: string) {
  st.log.unshift({ at: Date.now(), event, by });
  st.log.length = Math.min(st.log.length, 20);
}

export function intercomState(): IntercomState {
  // a ring the ESP never closed (WiFi drop) must not stay "ringing" forever
  if (st.ringingSince && Date.now() - st.ringingSince > RING_TTL_MS) st.ringingSince = null;
  if (st.autoOpenUntil && st.autoOpenUntil < Date.now()) {
    st.autoOpenUntil = null;
    note("disarmed", "expired");
  }
  return st;
}

export function isAutoOpenArmed(): boolean {
  return (intercomState().autoOpenUntil ?? 0) > Date.now();
}

export async function armAutoOpen(minutes: number, by = "web"): Promise<IntercomState> {
  st.autoOpenUntil = minutes > 0 ? Date.now() + minutes * 60_000 : null;
  note(minutes > 0 ? "armed" : "disarmed", by);
  await db.insert(auditLog).values({ accountId: "home", action: "intercom.autoopen", target: by, status: "ok", message: minutes > 0 ? `armed ${minutes} min` : "disarmed" });
  pushActivity({ at: Date.now(), kind: "other", text: minutes > 0 ? deviceText().autoOpenOn(minutes) : deviceText().autoOpenOff });
  publishToHa().catch(() => undefined);
  return st;
}

// Phone side goes through the vmui notification centre (lib/notify): the app
// renders the card with the two buttons, and the centre falls back to the HA
// Companion app on its own when no paired device acks within 20 s.
async function phoneRing() {
  const { notify } = await import("@/lib/notify");
  const { msg } = await import("@/lib/notify/i18n");
  await notify({
    kind: "intercom",
    tag: PHONE_TAG,
    title: msg("cards.intercom.ringTitle"),
    body: msg(isAutoOpenArmed() ? "cards.intercom.ringArmed" : "cards.intercom.ringAsk"),
    priority: "urgent",
    icon: "bell-ring",
    sticky: true,
    ttlSec: 55,
    force: true,
    actions: [
      { id: "open", label: msg("cards.intercom.open"), style: "primary" },
      { id: "ignore", label: msg("cards.intercom.ignore"), style: "ghost" },
    ],
  });
}

async function phoneClear() {
  const { dismissByTag } = await import("@/lib/notify");
  await dismissByTag(PHONE_TAG, "intercom");
}

async function phoneOpened(by: string) {
  const { notify } = await import("@/lib/notify");
  const { msg } = await import("@/lib/notify/i18n");
  await notify({ kind: "intercom", tag: PHONE_TAG, title: msg("cards.intercom.openedTitle"), body: by === "auto" ? msg("cards.intercom.openedAuto") : msg("cards.intercom.openedBy", { by }), color: "#2ecc71", icon: "door-open", priority: "low", ttlSec: 20, noFallback: true });
}

export async function publishToHa(): Promise<void> {
  if (!credential("HA_TOKEN")) return;
  const s = intercomState();
  await Promise.all([
    ha.setState("binary_sensor.vmui_intercom_ringing", s.ringingSince ? "on" : "off", { friendly_name: deviceText().haRinging, device_class: "sound", since: s.ringingSince, last_ring: s.lastRingAt }).catch(() => undefined),
    ha.setState("binary_sensor.vmui_intercom_auto_open", isAutoOpenArmed() ? "on" : "off", { friendly_name: deviceText().haAutoOpen, icon: "mdi:door-open", until: s.autoOpenUntil }).catch(() => undefined),
    ha.setState("sensor.vmui_intercom_last_open", s.lastOpenAt ? new Date(s.lastOpenAt).toISOString() : "unknown", { friendly_name: "Interfon ultima deschidere", device_class: "timestamp", icon: "mdi:door" }).catch(() => undefined),
  ]);
}

/** ESP -> vmui. Returns whether the ESP should run the open sequence now. */
export async function onEspEvent(event: IntercomEvent, node: string): Promise<{ open: boolean }> {
  st.node = node;
  const now = Date.now();
  if (event === "ring") {
    const armed = isAutoOpenArmed();
    st.ringingSince = now;
    st.lastRingAt = now;
    note("ring", node);
    pushActivity({ at: now, kind: "other", text: armed ? deviceText().ringingAutoOpen : deviceText().ringing });
    for (const n of listNodes()) showMessage(n.name, "INTERFON", armed ? "Suna jos. Deschid automat." : "Suna jos! Raspunde de pe telefon.", 30);
    await db.insert(auditLog).values({ accountId: "home", action: "intercom.ring", target: node, status: "ok", message: armed ? "auto-open armed" : "waiting" });
    phoneRing().catch((e) => console.error("[vmui] intercom phone push failed", e));
    publishToHa().catch(() => undefined);
    return { open: armed };
  }
  if (event === "opened") {
    st.lastOpenAt = now;
    const by = isAutoOpenArmed() && st.ringingSince ? "auto" : "telefon";
    note("opened", by);
    pushActivity({ at: now, kind: "other", text: deviceText().doorOpened(by) });
    for (const n of listNodes()) showMessage(n.name, "INTERFON", "Usa deschisa", 6);
    await db.insert(auditLog).values({ accountId: "home", action: "intercom.open", target: node, status: "ok", message: by });
    phoneOpened(by).catch(() => undefined);
    st.ringingSince = null;
    publishToHa().catch(() => undefined);
    return { open: false };
  }
  // end
  if (st.ringingSince) {
    note("end", node);
    st.ringingSince = null;
    for (const n of listNodes()) showMessage(n.name, "INTERFON", "Apel incheiat", 3);
    if (!st.lastOpenAt || now - st.lastOpenAt > 10_000) phoneClear().catch(() => undefined);
  }
  publishToHa().catch(() => undefined);
  return { open: false };
}

/** Stable reason for a refused open; humans see it through `notify.errors.noCall`. */
export const NO_CALL = "no_call";

/** Phone / web -> ESP: run the talk+open sequence. `error` is `NO_CALL` or the raw HA failure. */
export async function openDoor(by: string): Promise<{ ok: boolean; error?: string }> {
  if (!intercomState().ringingSince) {
    await db.insert(auditLog).values({ accountId: "home", action: "intercom.open", target: by, status: "error", message: "no call in progress" });
    return { ok: false, error: NO_CALL };
  }
  try {
    await ha.callService("esphome", `${st.node.replace(/-/g, "_")}_intercom_open`, {});
    await db.insert(auditLog).values({ accountId: "home", action: "intercom.open.request", target: by, status: "ok", message: st.node });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action: "intercom.open.request", target: by, status: "error", message: error });
    return { ok: false, error };
  }
}

export async function ignoreCall(by: string): Promise<void> {
  note("end", by);
  st.ringingSince = null;
  await phoneClear().catch(() => undefined);
  for (const n of listNodes()) showMessage(n.name, "INTERFON", "Ignorat", 3);
  await db.insert(auditLog).values({ accountId: "home", action: "intercom.ignore", target: by, status: "ok", message: "" });
  publishToHa().catch(() => undefined);
}
