import type { Locale } from "@/i18n/config";
import { db } from "@/lib/db";
import { auditLog, homeNotifications as notifications, pairedDevices, type HomeNotificationRow as NotificationRow } from "@/lib/db/schema";
import { credential } from "@/lib/home/credentials";
import { ha } from "@/lib/home/ha-client";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import "server-only";
import { z } from "zod";
import { sendFcm } from "./fcm";
import { deviceLocale, isMsg, packText, render, unpackText, type Text } from "./i18n";
import { loadNotifySettings } from "./settings";

// Notification centre. Every source (copilot, intercom, pairing, water, PC/Pi
// health, HA sensors) calls notify() once; the card is stored, streamed to
// connected apps (SSE /api/notify/stream), pushed through FCM to wake the
// phone, and — if no paired device acknowledges within FALLBACK_MS — sent
// through the HA Companion app as before. Actions come back through
// /api/notify/act and are routed by `kind` in ./actions.ts.

export const NOTIFY_KINDS = ["copilot", "agents", "intercom", "pairing", "water", "pc", "pi", "door", "window", "presence", "battery", "contact", "system"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** A literal string or a `{ key, params }` reference into messages/notify (rendered per consumer language). */
const textSchema = z.union([z.string().max(600), z.object({ key: z.string().min(1).max(80), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() })]);

export const actionSchema = z.object({
  id: z.string().min(1).max(40),
  label: textSchema,
  /** primary | danger | ghost */
  style: z.enum(["primary", "danger", "ghost"]).default("ghost"),
  /** opaque payload passed back to the source's action handler */
  body: z.record(z.string(), z.unknown()).optional(),
  /** open this URL instead of calling back (deep link) */
  url: z.string().max(400).optional(),
});
export type NotifyAction = z.infer<typeof actionSchema>;

export const notifyInputSchema = z.object({
  kind: z.enum(NOTIFY_KINDS),
  tag: z.string().max(80).optional(),
  title: textSchema,
  body: textSchema.default(""),
  subtitle: textSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(40).optional(),
  image: z.string().max(600).optional(),
  priority: z.enum(["low", "default", "high", "urgent"]).default("default"),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  actions: z.array(actionSchema).max(4).default([]),
  url: z.string().max(400).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  sticky: z.boolean().default(false),
  /** seconds; card auto-dismisses after */
  ttlSec: z.number().int().min(10).max(7 * 86400).optional(),
  /** skip the HA Companion fallback even if nobody acks (silent cards) */
  noFallback: z.boolean().default(false),
  /** deliver even in quiet hours */
  force: z.boolean().default(false),
});
export type NotifyInput = z.input<typeof notifyInputSchema>;

/** Stored shape: text fields may still be message refs. Render with `localizeCard` before showing. */
export type Card = Omit<NotificationRow, "actions" | "data" | "title" | "body" | "subtitle"> & { title: Text; body: Text; subtitle: Text | null; actions: NotifyAction[]; data: Record<string, unknown> };
/** Fully rendered for one language — what every API/SSE/FCM consumer receives. */
export type LocalizedCard = Omit<Card, "title" | "body" | "subtitle" | "actions"> & { title: string; body: string; subtitle: string | null; actions: Array<Omit<NotifyAction, "label"> & { label: string }> };

const FALLBACK_MS = 20_000;

type Bus = EventEmitter & { pendingFallback: Map<string, NodeJS.Timeout> };
const bus: Bus = ((globalThis as { __vmuiNotify__?: Bus }).__vmuiNotify__ ??= Object.assign(new EventEmitter(), { pendingFallback: new Map() }));
bus.setMaxListeners(100);

export function onNotify(fn: (ev: { type: "upsert" | "dismiss"; card: Card }) => void): () => void {
  bus.on("ev", fn);
  return () => bus.off("ev", fn);
}

export function toCard(r: NotificationRow): Card {
  let actions: NotifyAction[] = [];
  let data: Record<string, unknown> = {};
  try { actions = JSON.parse(r.actions) as NotifyAction[]; } catch { /* stored by us; unreachable */ }
  try { data = JSON.parse(r.data) as Record<string, unknown>; } catch { /* same */ }
  return { ...r, title: unpackText(r.title) ?? "", body: unpackText(r.body) ?? "", subtitle: unpackText(r.subtitle), actions, data };
}

export async function localizeCard(c: Card, locale: Locale): Promise<LocalizedCard> {
  const [title, body, subtitle, labels] = await Promise.all([
    render(c.title, locale),
    render(c.body, locale),
    c.subtitle == null ? Promise.resolve(null) : render(c.subtitle, locale),
    Promise.all(c.actions.map((a) => render(a.label, locale))),
  ]);
  return { ...c, title, body, subtitle, actions: c.actions.map((a, i) => ({ ...a, label: labels[i] ?? (isMsg(a.label) ? a.label.key : a.label) })) };
}

export const localizeCards = (cards: Card[], locale: Locale) => Promise.all(cards.map((c) => localizeCard(c, locale)));

/** Create or update (by tag) a card, then fan out. Returns the card, or null when muted. */
export async function notify(input: NotifyInput): Promise<Card | null> {
  const n = notifyInputSchema.parse(input);
  const s = await loadNotifySettings();
  const k = s.kinds[n.kind];
  if (!k.enabled) return null;
  const quiet = !n.force && s.quiet.enabled && inQuiet(s.quiet.from, s.quiet.to) && !k.breakQuiet;
  const now = new Date();
  const expiresAt = n.ttlSec ? new Date(now.getTime() + n.ttlSec * 1000) : null;
  const existing = n.tag ? await db.select().from(notifications).where(and(eq(notifications.tag, n.tag), isNull(notifications.dismissedAt))).get() : undefined;
  const values = {
    kind: n.kind,
    tag: n.tag ?? null,
    title: packText(n.title),
    body: packText(n.body),
    subtitle: n.subtitle == null ? null : packText(n.subtitle),
    color: n.color ?? k.color ?? null,
    icon: n.icon ?? k.icon ?? null,
    image: n.image ?? null,
    priority: n.priority,
    progress: n.progress ?? null,
    actions: JSON.stringify(n.actions),
    url: n.url ?? null,
    data: JSON.stringify(n.data),
    sticky: n.sticky,
    expiresAt,
    updatedAt: now,
  };
  let row: NotificationRow;
  if (existing) {
    await db.update(notifications).set({ ...values, readAt: null }).where(eq(notifications.id, existing.id));
    row = (await db.select().from(notifications).where(eq(notifications.id, existing.id)).get())!;
  } else {
    const id = randomBytes(8).toString("hex");
    await db.insert(notifications).values({ id, ...values, createdAt: now });
    row = (await db.select().from(notifications).where(eq(notifications.id, id)).get())!;
  }
  const card = toCard(row);
  bus.emit("ev", { type: "upsert", card });
  if (!quiet) {
    void wakePhones(card, s.fcm).catch((e) => console.warn("[vmui] fcm", e));
    // HA Companion fallback only for cards worth interrupting for
    if (s.haFallback && !n.noFallback && (n.priority === "high" || n.priority === "urgent") && !existing) scheduleFallback(card);
  }
  return card;
}

export async function dismiss(id: string, by = "system", actedWith?: string): Promise<Card | null> {
  const r = await db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!r) return null;
  if (r.dismissedAt) return toCard(r);
  const now = new Date();
  await db.update(notifications).set({ dismissedAt: now, readAt: r.readAt ?? now, actedWith: actedWith ?? r.actedWith, actedBy: actedWith ? by : r.actedBy, updatedAt: now }).where(eq(notifications.id, id));
  cancelFallback(id);
  // the phone's HA card too, if we fell back to it
  if (r.fallbackAt && r.tag) void haClear(r.tag);
  const card = toCard((await db.select().from(notifications).where(eq(notifications.id, id)).get())!);
  bus.emit("ev", { type: "dismiss", card });
  return card;
}

export async function dismissByTag(tag: string, by = "system"): Promise<void> {
  const rows = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.tag, tag), isNull(notifications.dismissedAt)));
  for (const r of rows) await dismiss(r.id, by);
}

export async function markRead(ids: string[]): Promise<void> {
  const now = new Date();
  for (const id of ids) await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.id, id), isNull(notifications.readAt)));
}

export async function ack(id: string, device: string): Promise<void> {
  const r = await db.select({ deliveredTo: notifications.deliveredTo }).from(notifications).where(eq(notifications.id, id)).get();
  if (!r || r.deliveredTo) return;
  await db.update(notifications).set({ deliveredTo: device }).where(eq(notifications.id, id));
  cancelFallback(id);
}

export async function listCards(opts: { includeDismissed?: boolean; limit?: number } = {}): Promise<Card[]> {
  const q = db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(opts.limit ?? 100);
  const rows = opts.includeDismissed ? await q : await q.where(isNull(notifications.dismissedAt));
  const now = Date.now();
  const out: Card[] = [];
  for (const r of rows) {
    if (!r.dismissedAt && r.expiresAt && r.expiresAt.getTime() < now) { void dismiss(r.id, "ttl"); continue; }
    out.push(toCard(r));
  }
  return out;
}

export async function getCard(id: string): Promise<Card | null> {
  const r = await db.select().from(notifications).where(eq(notifications.id, id)).get();
  return r ? toCard(r) : null;
}

// ---------------------------------------------------------------- delivery

function inQuiet(from: string, to: string): boolean {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = (fh ?? 0) * 60 + (fm ?? 0);
  const b = (th ?? 0) * 60 + (tm ?? 0);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

async function wakePhones(card: Card, fcm: { enabled: boolean }): Promise<void> {
  if (!fcm.enabled) return;
  const devs = await db.select({ id: pairedDevices.id, pushToken: pairedDevices.pushToken, language: pairedDevices.language }).from(pairedDevices).where(eq(pairedDevices.status, "approved"));
  // one FCM payload per language the paired phones speak
  const byLocale = new Map<Locale, string[]>();
  for (const d of devs) {
    if (!d.pushToken) continue;
    const l = deviceLocale(d.language);
    byLocale.set(l, [...(byLocale.get(l) ?? []), d.pushToken]);
  }
  for (const [locale, tokens] of byLocale) {
    const gone = await sendFcm(tokens, await localizeCard(card, locale));
    for (const t of gone) await db.update(pairedDevices).set({ pushToken: null }).where(eq(pairedDevices.pushToken, t));
  }
}

function scheduleFallback(card: Card) {
  cancelFallback(card.id);
  const t = setTimeout(async () => {
    bus.pendingFallback.delete(card.id);
    const r = await db.select().from(notifications).where(eq(notifications.id, card.id)).get();
    if (!r || r.dismissedAt || r.deliveredTo) return;
    const s = await loadNotifySettings();
    await haFallback(await localizeCard(toCard(r), s.language));
    await db.update(notifications).set({ fallbackAt: new Date() }).where(eq(notifications.id, card.id));
  }, FALLBACK_MS);
  t.unref();
  bus.pendingFallback.set(card.id, t);
}

function cancelFallback(id: string) {
  const t = bus.pendingFallback.get(id);
  if (t) { clearTimeout(t); bus.pendingFallback.delete(id); }
}

const phoneService = () => credential("PHONE_NOTIFY_SERVICE") ?? "mobile_app_dragos_s_s25_ultra";
const MDI: Partial<Record<NotifyKind, string>> = { copilot: "mdi:robot", agents: "mdi:robot", intercom: "mdi:doorbell", pairing: "mdi:cellphone-link", water: "mdi:cup-water", pc: "mdi:desktop-tower", pi: "mdi:raspberry-pi", door: "mdi:door", window: "mdi:window-open", presence: "mdi:motion-sensor", battery: "mdi:battery-alert", contact: "mdi:email-alert", system: "mdi:information" };

/** Same content through the HA Companion app; actions become NOTIFY_<id>_<actionId>. */
async function haFallback(card: LocalizedCard): Promise<void> {
  if (!credential("HA_TOKEN")) return;
  try {
    await ha.callService("notify", phoneService(), {
      title: card.title,
      message: card.body || card.subtitle || " ",
      data: {
        tag: `vmui-${card.tag ?? card.id}`,
        group: `vmui-${card.kind}`,
        channel: `vmui ${card.kind}`,
        importance: card.priority === "urgent" ? "max" : card.priority === "high" ? "high" : "default",
        color: card.color ?? undefined,
        notification_icon: MDI[card.kind as NotifyKind] ?? "mdi:bell",
        subtitle: card.subtitle ?? undefined,
        image: card.image ?? undefined,
        sticky: card.sticky,
        ttl: 0,
        priority: "high",
        clickAction: card.url ?? undefined,
        actions: card.actions.slice(0, 3).map((a) => (a.url ? { action: "URI", title: a.label, uri: a.url } : { action: `NOTIFY_${card.id}_${a.id}`, title: a.label })),
      },
    });
    await db.insert(auditLog).values({ accountId: "notify", action: "notify.fallback", target: card.id, status: "ok", message: `${card.kind}: ${card.title}`.slice(0, 200) });
  } catch (e) {
    console.warn("[vmui] HA fallback failed", e);
  }
}

async function haClear(tag: string): Promise<void> {
  if (!credential("HA_TOKEN")) return;
  await ha.callService("notify", phoneService(), { message: "clear_notification", data: { tag: `vmui-${tag}` } }).catch(() => undefined);
}
