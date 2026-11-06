"use server";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { HomeAccessError, requireOwner } from "@/lib/home/access";
import { importFromHomeAssistant, type ImportPlan } from "@/lib/home/ha-import";
import { deleteDevice, deleteRoom, upsertDevice, upsertRoom } from "@/lib/home/house";
import { revalidatePath } from "next/cache";
import { z } from "zod";

// Owner-only editing of the house (rooms + devices) and the Home Assistant import.
// Zod -> authz (requireOwner) -> mutate -> audit -> revalidate, like the other home actions.

type Result<T = undefined> = ({ ok: true } & (T extends undefined ? object : { data: T })) | { ok: false; error: string };

const slug = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const pct = z.number().min(0).max(100);
const entity = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);

const roomInput = z.object({ id: slug, name: z.string().trim().min(1).max(60), x: pct, y: pct, w: pct.min(5), h: pct.min(5), sort: z.number().int().min(0).max(999).optional() });
const deviceInput = z.object({
  id: slug,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["light", "strip", "projector", "ac", "tv", "display", "monitor", "sensor", "presence", "door", "pc", "proxy"]),
  room: slug,
  entity: entity.optional(),
  entities: z.array(entity).max(30).optional(),
  x: pct,
  y: pct,
  via: z.string().max(80).default(""),
  whiteOnly: z.boolean().optional(),
  notes: z.string().max(300).optional(),
});

async function guarded<T>(action: string, target: string, fn: () => Promise<T> | T): Promise<Result<T extends undefined ? undefined : T>> {
  try {
    await requireOwner();
    const data = await fn();
    await db.insert(auditLog).values({ accountId: "home", action, target, status: "ok", message: "" });
    revalidatePath("/home");
    return (data === undefined ? { ok: true } : { ok: true, data }) as Result<T extends undefined ? undefined : T>;
  } catch (e) {
    const error = e instanceof HomeAccessError ? "forbidden" : e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action, target, status: "error", message: error.slice(0, 300) });
    return { ok: false, error };
  }
}

export async function saveRoomAction(input: z.input<typeof roomInput>): Promise<Result> {
  const p = roomInput.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid" };
  return guarded("house.room.save", p.data.id, () => upsertRoom(p.data));
}

export async function deleteRoomAction(id: string): Promise<Result> {
  const p = slug.safeParse(id);
  if (!p.success) return { ok: false, error: "invalid" };
  return guarded("house.room.delete", p.data, () => deleteRoom(p.data));
}

export async function saveDeviceAction(input: z.input<typeof deviceInput>): Promise<Result> {
  const p = deviceInput.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid" };
  return guarded("house.device.save", p.data.id, () => upsertDevice(p.data));
}

export async function deleteDeviceAction(id: string): Promise<Result> {
  const p = slug.safeParse(id);
  if (!p.success) return { ok: false, error: "invalid" };
  return guarded("house.device.delete", p.data, () => deleteDevice(p.data));
}

/** dryRun = preview what would be added; otherwise add new HA areas/devices. */
export async function importFromHaAction(dryRun: boolean): Promise<Result<ImportPlan>> {
  return guarded(dryRun ? "house.import.preview" : "house.import", "home-assistant", () => importFromHomeAssistant({ dryRun }));
}
