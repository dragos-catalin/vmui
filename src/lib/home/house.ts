import "server-only";

import { db } from "@/lib/db";
import { homeDevices, homeRooms } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { DEVICES, ROOMS, type CatalogDevice, type DeviceKind, type HomeRoom } from "./catalog";

/**
 * The house as data. Rooms and devices live in `home_rooms` / `home_devices`;
 * `lib/home/catalog.ts` is only the seed for the original install. On an empty
 * table we seed it ONCE from the catalog (owner install keeps its house) unless
 * VATRA_EMPTY_HOUSE=1 (fresh product install: the setup wizard imports HA areas).
 *
 * Synchronous (better-sqlite3) and cached for 5 s: access checks call it per request.
 */

export type House = { rooms: HomeRoom[]; devices: CatalogDevice[] };

let cache: { at: number; house: House } | null = null;

function seedIfEmpty(): void {
  if (db.select({ id: homeRooms.id }).from(homeRooms).limit(1).get()) return;
  if (process.env.VATRA_EMPTY_HOUSE === "1") return;
  db.transaction((tx) => {
    ROOMS.forEach((r, i) => tx.insert(homeRooms).values({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, sort: i }).onConflictDoNothing().run());
    DEVICES.forEach((d, i) =>
      tx
        .insert(homeDevices)
        .values({ id: d.id, roomId: d.room, name: d.name, kind: d.kind, entity: d.entity ?? null, entities: JSON.stringify(d.entities ?? []), x: d.x, y: d.y, ambilight: d.ambilight ?? null, whiteOnly: d.whiteOnly ?? false, via: d.via, notes: d.notes ?? null, sort: i })
        .onConflictDoNothing()
        .run(),
    );
  });
}

function parseList(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function house(): House {
  if (cache && Date.now() - cache.at < 5_000) return cache.house;
  seedIfEmpty();
  const rooms = db.select().from(homeRooms).orderBy(asc(homeRooms.sort), asc(homeRooms.name)).all().map((r) => ({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h }));
  const devices = db
    .select()
    .from(homeDevices)
    .orderBy(asc(homeDevices.sort), asc(homeDevices.name))
    .all()
    .map(
      (d): CatalogDevice => ({
        id: d.id,
        name: d.name,
        kind: d.kind as DeviceKind,
        room: d.roomId,
        x: d.x,
        y: d.y,
        via: d.via,
        ...(d.entity ? { entity: d.entity } : {}),
        ...(parseList(d.entities).length ? { entities: parseList(d.entities) } : {}),
        ...(d.ambilight ? { ambilight: d.ambilight as CatalogDevice["ambilight"] } : {}),
        ...(d.whiteOnly ? { whiteOnly: true } : {}),
        ...(d.notes ? { notes: d.notes } : {}),
      }),
    );
  cache = { at: Date.now(), house: { rooms, devices } };
  return cache.house;
}

export const houseRooms = (): HomeRoom[] => house().rooms;
export const houseDevices = (): CatalogDevice[] => house().devices;
export const invalidateHouse = (): void => {
  cache = null;
};

/** Every HA entity a device in the house owns (whitelists for token routes). */
export function houseEntities(): Set<string> {
  const out = new Set<string>();
  for (const d of houseDevices()) {
    if (d.entity) out.add(d.entity);
    for (const e of d.entities ?? []) out.add(e);
  }
  return out;
}

export function upsertRoom(r: HomeRoom & { sort?: number; haArea?: string | null }): void {
  db.insert(homeRooms)
    .values({ id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, sort: r.sort ?? 0, haArea: r.haArea ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: homeRooms.id, set: { name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, haArea: r.haArea ?? null, updatedAt: new Date() } })
    .run();
  invalidateHouse();
}

export function deleteRoom(id: string): void {
  if (db.select({ id: homeDevices.id }).from(homeDevices).where(eq(homeDevices.roomId, id)).limit(1).get()) throw new Error("room_not_empty");
  db.delete(homeRooms).where(eq(homeRooms.id, id)).run();
  invalidateHouse();
}

export function upsertDevice(d: CatalogDevice & { haDevice?: string | null }): void {
  const v = { roomId: d.room, name: d.name, kind: d.kind, entity: d.entity ?? null, entities: JSON.stringify(d.entities ?? []), x: d.x, y: d.y, ambilight: d.ambilight ?? null, whiteOnly: d.whiteOnly ?? false, via: d.via, notes: d.notes ?? null, haDevice: d.haDevice ?? null, updatedAt: new Date() };
  db.insert(homeDevices).values({ id: d.id, ...v }).onConflictDoUpdate({ target: homeDevices.id, set: v }).run();
  invalidateHouse();
}

export function deleteDevice(id: string): void {
  db.delete(homeDevices).where(eq(homeDevices.id, id)).run();
  invalidateHouse();
}
