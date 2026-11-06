import "server-only";

import { authEnabled, getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { homeMembers, pairedDevices, users, type HomeMemberRow, type UserRow } from "@/lib/db/schema";
import { DEVICES, ROOMS, type RoomId } from "@/lib/home/catalog";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

// Family access model for /home.
//
//   role      rooms                       intercom door   settings / arrange   nutrition
//   owner     every room, control         open            yes                  own journal, sees household
//   adult     as granted                  open            no                   own journal
//   child     as granted                  view state      no                   own journal
//   guest     as granted, until expiresAt view state      no                   own journal
//
// Room level: "view" = see state, no controls; "control" = drive the devices.
// `users.role` (admin/operator/viewer) is the VM control plane and is NOT
// consulted here, except that an infrastructure admin with no membership row
// is treated as owner so the first user is never locked out of their own home.

import { FAMILY_ROLES, ROOM_LEVELS, type FamilyRole, type HomeAccessView, type RoomGrants, type RoomLevel } from "./access-model";
import { ownerPhoneSensor } from "@/lib/household";
export { FAMILY_ROLES, ROOM_LEVELS, type FamilyRole, type HomeAccessView, type RoomGrants, type RoomLevel };

export const roomIdSchema = z.enum(ROOMS.map((r) => r.id) as [RoomId, ...RoomId[]]);
export const roomGrantsSchema = z.partialRecord(roomIdSchema, z.enum(ROOM_LEVELS)) as z.ZodType<RoomGrants>;
export const inviteRoleSchema = z.enum(["adult", "child", "guest"]);

export type HomeActor = {
  userId: string;
  email: string;
  displayName: string;
  role: FamilyRole;
  rooms: RoomGrants;
  expiresAt: Date | null;
  /** Paired device the request came from, when not a browser session. */
  deviceId: string | null;
};

const ALL_CONTROL: RoomGrants = Object.fromEntries(ROOMS.map((r) => [r.id, "control"])) as RoomGrants;

export function parseGrants(json: string): RoomGrants {
  try {
    const p = roomGrantsSchema.safeParse(JSON.parse(json));
    return p.success ? p.data : {};
  } catch {
    return {};
  }
}

function toActor(user: Pick<UserRow, "id" | "email" | "displayName" | "role">, m: HomeMemberRow | null, deviceId: string | null): HomeActor | null {
  if (!m) {
    if (user.role === "admin") return { userId: user.id, email: user.email, displayName: user.displayName, role: "owner", rooms: ALL_CONTROL, expiresAt: null, deviceId };
    return null;
  }
  if (m.expiresAt && m.expiresAt.getTime() < Date.now()) return null;
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: m.role,
    rooms: m.role === "owner" ? ALL_CONTROL : parseGrants(m.rooms),
    expiresAt: m.expiresAt,
    deviceId,
  };
}

/** Single-user installs (no accounts yet) get a synthetic owner so nothing is gated. */
const SOLO_OWNER: HomeActor = { userId: "solo", email: "", displayName: "", role: "owner", rooms: ALL_CONTROL, expiresAt: null, deviceId: null };

async function memberRow(userId: string): Promise<HomeMemberRow | null> {
  return (await db.select().from(homeMembers).where(eq(homeMembers.userId, userId)).get()) ?? null;
}

/** The signed-in browser user as a household actor, or null when they have no access. */
export async function currentHomeActor(): Promise<HomeActor | null> {
  if (!(await authEnabled())) return SOLO_OWNER;
  const u = await getCurrentUser();
  if (!u) return null;
  return toActor(u, await memberRow(u.id), null);
}

/** A paired phone/desktop acts as the member it was bound to at approval. */
export async function deviceHomeActor(req: Request): Promise<HomeActor | null> {
  const auth = req.headers.get("authorization") ?? "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("d") ?? "";
  if (!tok.startsWith("vmd_")) return null;
  const hash = createHash("sha256").update(tok).digest("hex");
  const d = await db.select().from(pairedDevices).where(and(eq(pairedDevices.tokenHash, hash), eq(pairedDevices.status, "approved"))).get();
  if (!d?.userId) return null;
  const u = await db.select().from(users).where(eq(users.id, d.userId)).get();
  if (!u) return null;
  return toActor(u, await memberRow(u.id), d.id);
}

/** Browser session first, then a bound device token. */
export async function homeActorFromRequest(req: Request): Promise<HomeActor | null> {
  return (await deviceHomeActor(req)) ?? (await currentHomeActor());
}

/** The household owner (first one by creation). Shared-token callers with no
 *  identity — ESP32 desk button, Nest Hub, HA rest_command, the codai phone
 *  assistant — act on the owner's behalf: those devices are physically theirs. */
export async function ownerActor(): Promise<HomeActor | null> {
  if (!(await authEnabled())) return SOLO_OWNER;
  const m = await db.select().from(homeMembers).where(eq(homeMembers.role, "owner")).orderBy(homeMembers.createdAt).get();
  if (m) {
    const u = await db.select().from(users).where(eq(users.id, m.userId)).get();
    if (u) return toActor(u, m, null);
  }
  const admin = await db.select().from(users).where(eq(users.role, "admin")).orderBy(users.createdAt).get();
  return admin ? toActor(admin, null, null) : null;
}

/** For routes that accept a bound device, a session, or the shared token (in that order). */
export async function homeActorOrOwner(req: Request, sharedTokenOk: boolean): Promise<HomeActor | null> {
  return (await homeActorFromRequest(req)) ?? (sharedTokenOk ? await ownerActor() : null);
}

const hasDeviceToken = (req: Request): boolean => {
  const auth = req.headers.get("authorization") ?? "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("d") ?? "";
  return tok.startsWith("vmd_");
};

/**
 * Actor for the token-authenticated routes (/api/display/*, /api/lights, /api/desktop/*).
 * Call only after `espAuthorized(req)` passed.
 *   - paired device -> the member it is bound to; an approved but UNBOUND device gets
 *     no actor (it used to inherit owner rights, so a guest's phone controlled every room);
 *   - shared house token (ESP32, Nest Hub, HA, owner's PC) -> the owner;
 *   - browser session -> that member.
 */
export async function tokenActor(req: Request): Promise<HomeActor | null> {
  if (hasDeviceToken(req)) return deviceHomeActor(req);
  return (await currentHomeActor()) ?? (await ownerActor());
}

/** Room-level check for an entity: house-wide entities need control somewhere. */
export function canControlEntity(a: HomeActor, entity: string): boolean {
  const room = roomOfEntity(entity);
  return room === null ? canControlAny(a) : canControl(a, room);
}

/** PC agent, Pi services, desktop settings: the owner's machines. Call after espAuthorized. */
export async function ownerTokenAuthorized(req: Request): Promise<boolean> {
  const a = await tokenActor(req);
  return a !== null && isOwner(a);
}

/** Journal owner for nutrition writes: `"solo"` installs map to null (single household, no user rows). */
export const journalUserId = (a: HomeActor): string | null => (a.userId === "solo" ? null : a.userId);

export const roomOf = (deviceId: string): RoomId | null => DEVICES.find((d) => d.id === deviceId)?.room ?? null;

const entityRoom = new Map<string, RoomId>();
for (const d of DEVICES) {
  if (d.entity) entityRoom.set(d.entity, d.room);
  for (const e of d.entities ?? []) entityRoom.set(e, d.room);
}
/** Room an HA entity belongs to per the catalog; `light.hyperhdr` and other house-wide entities return null. */
export const roomOfEntity = (entity: string): RoomId | null => entityRoom.get(entity) ?? null;

export function roomLevel(a: HomeActor, room: RoomId): RoomLevel | null {
  return a.rooms[room] ?? null;
}
export const canView = (a: HomeActor, room: RoomId) => roomLevel(a, room) !== null;
export const canControl = (a: HomeActor, room: RoomId) => roomLevel(a, room) === "control";
/** Rooms the actor may see, in floor-plan order. */
export const visibleRooms = (a: HomeActor): RoomId[] => ROOMS.map((r) => r.id).filter((r) => canView(a, r));
/** House-wide features (ambilight scenes, wall colour) need control in at least one room. */
export const canControlAny = (a: HomeActor) => ROOMS.some((r) => canControl(a, r.id));
export const isOwner = (a: HomeActor) => a.role === "owner";
/** Owner and adults may open the door; children and guests only watch it. */
export const canOpenDoor = (a: HomeActor) => a.role === "owner" || a.role === "adult";
/** Turzx, Nest Hub, desk button, Copilot signals, floor-plan arrangement, family management. */
export const canManageHome = isOwner;

export class HomeAccessError extends Error {
  constructor(message = "No access to this room") {
    super(message);
    this.name = "HomeAccessError";
  }
}

export async function requireHomeActor(): Promise<HomeActor> {
  const a = await currentHomeActor();
  if (!a) throw new HomeAccessError("Not a member of this home");
  return a;
}

/** Entity-level gate for server actions: the entity's room must be granted at `control`. */
export async function requireEntityControl(entity: string): Promise<HomeActor> {
  const a = await requireHomeActor();
  const room = roomOfEntity(entity);
  if (room === null) {
    if (!canControlAny(a)) throw new HomeAccessError();
    return a;
  }
  if (!canControl(a, room)) throw new HomeAccessError();
  return a;
}

export async function requireOwner(): Promise<HomeActor> {
  const a = await requireHomeActor();
  if (!canManageHome(a)) throw new HomeAccessError("Only the home owner can do this");
  return a;
}

export async function requireDoorAccess(): Promise<HomeActor> {
  const a = await requireHomeActor();
  if (!canOpenDoor(a)) throw new HomeAccessError("Only adults can open the door");
  return a;
}

/** Entities the actor is allowed to see; drives both the initial state load and the SSE stream. */
export function visibleEntities(a: HomeActor): Set<string> {
  const out = new Set<string>();
  for (const d of DEVICES) {
    if (!canView(a, d.room)) continue;
    if (d.entity) out.add(d.entity);
    for (const e of d.entities ?? []) out.add(e);
  }
  if (canControlAny(a)) out.add("light.hyperhdr");
  const notif = ownerPhoneSensor("last_notification");
  if (isOwner(a) && notif) out.add(notif);
  return out;
}

/** Plain-object view of the actor for client components (they import the type from access-model). */
export const accessView = (a: HomeActor): HomeAccessView => ({
  role: a.role,
  rooms: a.rooms,
  canOpenDoor: canOpenDoor(a),
  canManage: canManageHome(a),
  canControlAny: canControlAny(a),
  userId: a.userId,
  displayName: a.displayName,
});
