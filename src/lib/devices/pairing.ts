import { db } from "@/lib/db";
import { auditLog, pairedDevices, type PairedDeviceRow } from "@/lib/db/schema";
import { APPLIANCE_PROFILES, type ApplianceProfile } from "@/lib/devices/appliance-scopes";
import { redeemDemoInvite } from "@/lib/demo/invite";
import { requestCredential } from "@/lib/esp/auth";
import { msg } from "@/lib/notify/i18n";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import "server-only";

// Device pairing for the phone / desktop apps.
//
//   1. the app discovers vmui (mDNS _vmui._tcp on the LAN, Tailscale MagicDNS
//      `homepi` from outside) and POSTs /api/devices/pair with its name.
//      It gets back {id, token, code} and starts polling /api/devices/pair/:id.
//   2. someone approves it: a signed-in vmui user (web, or the desktop app's
//      window), or an already-approved device, after comparing the 4-digit
//      code. Or the app signs in with the vmui account and is approved at once.
//   3. from then on the app authenticates with `Authorization: Bearer <token>`
//      (or ?d=<token>); espAuthorized() accepts both that and the legacy
//      ESP_DISPLAY_TOKEN, so every /api/display, /api/desktop route just works.
//
// Tokens are stored hashed; the clear token lives only on the device.

const PENDING_TTL_MS = 10 * 60_000;

export type DeviceInfo = Omit<PairedDeviceRow, "tokenHash" | "code">;
export type PairingTicket = { id: string; token: string; code: string };
/** Why an approval was refused; the caller renders it (`notify.errors.pairing.*`). */
export type PairingError = "not_found" | "expired" | "code_mismatch";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const strip = (r: PairedDeviceRow): DeviceInfo => {
  const { tokenHash: _h, code: _c, ...rest } = r;
  return rest;
};

/** In-process change counter so clients can long-poll cheaply (GET /api/devices?since=). */
let version = 0;
export const devicesVersion = () => version;
function bump() {
  version++;
}

export async function requestPairing(name: string, platform: string, ip: string | null, language: string | null = null): Promise<PairingTicket> {
  // one pending request per name+ip; a retry replaces it instead of piling up
  const stale = await db.select().from(pairedDevices).where(eq(pairedDevices.status, "pending"));
  for (const s of stale) {
    if (s.name === name && s.lastIp === ip) await db.delete(pairedDevices).where(eq(pairedDevices.id, s.id));
    else if (s.createdAt.getTime() < Date.now() - PENDING_TTL_MS) await db.delete(pairedDevices).where(eq(pairedDevices.id, s.id));
  }
  const id = randomBytes(8).toString("hex");
  const token = "vmd_" + randomBytes(24).toString("base64url");
  const code = String(randomInt(0, 10000)).padStart(4, "0");
  await db.insert(pairedDevices).values({ id, name: name.slice(0, 64), platform: platform.slice(0, 32), tokenHash: hash(token), status: "pending", code, lastIp: ip, lastSeenAt: new Date(), language });
  await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.request", target: id, status: "ok", message: `${name} (${platform}) from ${ip ?? "?"} code ${code}` });
  bump();
  // card on every surface (phone, desktop, web); the code must match what the new device shows
  void import("@/lib/notify").then(({ notify }) =>
    notify({
      kind: "pairing",
      tag: `pair-${id}`,
      title: msg("cards.pairing.title", { name }),
      body: msg("cards.pairing.body", { platform, ip: ip ?? "?", code }),
      subtitle: msg("cards.pairing.subtitle", { code }),
      priority: "high",
      sticky: true,
      ttlSec: PENDING_TTL_MS / 1000,
      actions: [
        { id: "approve", label: msg("cards.pairing.approve", { code }), style: "primary", body: { deviceId: id, code } },
        { id: "reject", label: msg("cards.pairing.reject"), style: "danger", body: { deviceId: id } },
      ],
      data: { deviceId: id, code, platform },
    }),
  ).catch(() => undefined);
  return { id, token, code };
}

export async function pairingStatus(id: string): Promise<{ status: string; code: string | null } | null> {
  const r = await db.select().from(pairedDevices).where(eq(pairedDevices.id, id)).get();
  return r ? { status: r.status, code: r.status === "pending" ? r.code : null } : null;
}

// ---------------------------------------------------------------- QR pairing
// A signed-in member taps "Add a device": the hub mints a one-time invite (5 min,
// single use) and shows `vatra://pair?h=<hub>&c=<code>` as a QR. The app redeems it
// at POST /api/devices/pair {invite} and is approved at once, bound to that member:
// no 4-digit comparison, no "approved by whom" ambiguity. Kept in memory: a restart
// simply invalidates open invites.

const INVITE_TTL_MS = 5 * 60_000;
type Invite = { userId: string; by: string; expires: number };
const invites: Map<string, Invite> = ((globalThis as { __vatraPairInvites__?: Map<string, Invite> }).__vatraPairInvites__ ??= new Map());

export function createPairingInvite(userId: string, by: string): { code: string; expiresAt: number } {
  const now = Date.now();
  for (const [c, i] of invites) if (i.expires < now) invites.delete(c);
  // 128-bit, URL-safe; it travels only inside the QR / deep link
  const code = randomBytes(16).toString("base64url");
  const expires = now + INVITE_TTL_MS;
  invites.set(hash(code), { userId, by, expires });
  return { code, expiresAt: expires };
}

/** Single use. Returns the ticket for the new device, or null when unknown/expired/used. */
export async function redeemPairingInvite(code: string, name: string, platform: string, ip: string | null, language: string | null): Promise<PairingTicket | null> {
  // demo hub (P10-04): the static invite published in the store notes pairs as the reviewer, never consumed
  const demo = await redeemDemoInvite(code);
  if (demo) {
    const t = await approveByLogin(name, platform, ip, demo.email, language, demo.userId);
    await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.demo", target: t.id, status: "ok", message: `${name} (${platform}) via the demo invite` });
    return t;
  }
  const key = hash(code);
  const inv = invites.get(key);
  invites.delete(key);
  if (!inv || inv.expires < Date.now()) return null;
  const t = await approveByLogin(name, platform, ip, inv.by, language, inv.userId);
  await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.qr", target: t.id, status: "ok", message: `${name} (${platform}) via QR from ${inv.by}` });
  return t;
}

/** Platforms of the Vitals apps; they read the owner's own health (`/api/v1/me/health`). */
export const VITALS_PLATFORMS = new Set(["vitals-desktop", "vitals-ios", "vitals-android"]);

/**
 * Who a newly approved device acts as. The approver's own member when known.
 * An approval through the shared desktop token has no identity: a Vitals app
 * is then bound to the household owner, because the token lives on the
 * owner's PC and an unbound Vitals device can never read its Health page
 * (S23-14, live test 2026-10-28: approved, then 401). Every other platform
 * stays unbound until rebound in the family card, as before.
 */
export function bindingFor(platform: string, approverUserId: string | null, ownerUserId: string | null): string | null {
  if (approverUserId) return approverUserId;
  return VITALS_PLATFORMS.has(platform) ? ownerUserId : null;
}

/** `userId` = the family member this device will act as (lib/home/access.ts); the approver binds it to themselves by default. `ownerUserId` is used only by `bindingFor`. */
export async function approveDevice(id: string, code: string, by: string, approverUserId: string | null = null, ownerUserId: string | null = null): Promise<{ ok: true } | { ok: false; error: PairingError }> {
  const r = await db.select().from(pairedDevices).where(eq(pairedDevices.id, id)).get();
  if (!r || r.status !== "pending") return { ok: false, error: "not_found" };
  if (r.createdAt.getTime() < Date.now() - PENDING_TTL_MS) return { ok: false, error: "expired" };
  if ((r.code ?? "") !== code) return { ok: false, error: "code_mismatch" };
  const userId = bindingFor(r.platform, approverUserId, ownerUserId);
  await db.update(pairedDevices).set({ status: "approved", code: null, approvedBy: by, userId }).where(eq(pairedDevices.id, id));
  await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.approve", target: id, status: "ok", message: `${r.name} approved by ${by}${userId ? ` as user ${userId}` : ""}` });
  bump();
  void import("@/lib/notify").then((n) => n.dismissByTag(`pair-${id}`, by)).catch(() => undefined);
  return { ok: true };
}

export async function rejectDevice(id: string, by: string): Promise<void> {
  await db.delete(pairedDevices).where(and(eq(pairedDevices.id, id), eq(pairedDevices.status, "pending")));
  await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.reject", target: id, status: "ok", message: `by ${by}` });
  bump();
  void import("@/lib/notify").then((n) => n.dismissByTag(`pair-${id}`, by)).catch(() => undefined);
}

/** Sign-in path: the device proved it holds the vmui account, so it is approved immediately. */
export async function approveByLogin(name: string, platform: string, ip: string | null, userEmail: string, language: string | null = null, userId: string | null = null): Promise<PairingTicket> {
  const id = randomBytes(8).toString("hex");
  const token = "vmd_" + randomBytes(24).toString("base64url");
  await db.insert(pairedDevices).values({ id, name: name.slice(0, 64), platform: platform.slice(0, 32), tokenHash: hash(token), status: "approved", approvedBy: userEmail, lastIp: ip, lastSeenAt: new Date(), language, userId });
  await db.insert(auditLog).values({ accountId: "devices", action: "device.pair.login", target: id, status: "ok", message: `${name} (${platform}) signed in as ${userEmail}` });
  bump();
  return { id, token, code: "" };
}

export async function revokeDevice(id: string, by: string): Promise<void> {
  await db.update(pairedDevices).set({ status: "revoked" }).where(eq(pairedDevices.id, id));
  await db.insert(auditLog).values({ accountId: "devices", action: "device.revoke", target: id, status: "ok", message: `by ${by}` });
  bump();
}

/** Owner mints a token for one piece of hardware (ESP32, desk button, Nest Hub, HA…): it can only
 *  call its profile's routes and is revoked like any device. Replaces the shared ESP_DISPLAY_TOKEN. */
export async function mintApplianceToken(profile: ApplianceProfile, name: string, by: string, ownerUserId: string | null): Promise<{ id: string; token: string }> {
  const id = randomBytes(8).toString("hex");
  const token = "vmd_" + randomBytes(24).toString("base64url");
  await db.insert(pairedDevices).values({ id, name: name.slice(0, 64), platform: `appliance:${profile}`, tokenHash: hash(token), status: "approved", approvedBy: by, userId: ownerUserId, scopes: JSON.stringify(APPLIANCE_PROFILES[profile]) });
  await db.insert(auditLog).values({ accountId: "devices", action: "device.appliance.mint", target: id, status: "ok", message: `${name} (${profile}) by ${by}` });
  bump();
  return { id, token };
}

export async function renameDevice(id: string, name: string): Promise<void> {
  await db.update(pairedDevices).set({ name: name.slice(0, 64) }).where(eq(pairedDevices.id, id));
  bump();
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const rows = await db.select().from(pairedDevices).orderBy(desc(pairedDevices.createdAt));
  const cutoff = Date.now() - PENDING_TTL_MS;
  return rows.filter((r) => r.status !== "pending" || r.createdAt.getTime() >= cutoff).map(strip);
}

export async function pendingDevices(): Promise<Array<DeviceInfo & { code: string }>> {
  const rows = await db.select().from(pairedDevices).where(eq(pairedDevices.status, "pending"));
  const cutoff = Date.now() - PENDING_TTL_MS;
  return rows.filter((r) => r.createdAt.getTime() >= cutoff).map((r) => ({ ...strip(r), code: r.code ?? "" }));
}

/** The device behind a request, if its token is approved (for "approved device approves another"). */
export async function deviceFromRequest(req: Request): Promise<DeviceInfo | null> {
  const tok = requestCredential(req);
  if (!tok.startsWith("vmd_")) return null;
  const r = await db.select().from(pairedDevices).where(eq(pairedDevices.tokenHash, hash(tok))).get();
  if (!r || r.status !== "approved") return null;
  return strip(r);
}
