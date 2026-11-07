"use server";

import { issueSessionForUser } from "@/lib/auth";
import { demoRefusal } from "@/lib/demo/mode";
import { FAMILY_ROLES, HomeAccessError, inviteRoleSchema, requireOwner, roomGrantsSchema, type RoomGrants } from "@/lib/home/access";
import { acceptInvite, bindDevice, createInvite, createMemberAccount, inviteByToken, ownerCount, removeMember, revokeInvite, upsertMember } from "@/lib/home/family";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

async function owner<T>(fn: (by: string) => Promise<T>): Promise<Result<{ data: T }>> {
  const demo = demoRefusal();
  if (demo) return demo;
  try {
    const a = await requireOwner();
    const data = await fn(a.email || "owner");
    revalidatePath("/home");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? e.message : e instanceof Error ? e.message : "Failed" };
  }
}

const expiry = z.iso.datetime().nullable().optional();
const toDate = (s: string | null | undefined) => (s ? new Date(s) : null);
const memberInput = z.object({ userId: z.string().min(1), role: z.enum(FAMILY_ROLES), rooms: roomGrantsSchema, expiresAt: expiry });

export async function upsertMemberAction(input: { userId: string; role: (typeof FAMILY_ROLES)[number]; rooms: RoomGrants; expiresAt?: string | null }): Promise<Result> {
  const p = memberInput.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const r = await owner(async (by) => {
    if (p.data.role !== "owner") {
      const a = await requireOwner();
      if (a.userId === p.data.userId && (await ownerCount()) <= 1) throw new HomeAccessError("The last owner cannot be demoted");
    }
    await upsertMember({ userId: p.data.userId, role: p.data.role, rooms: p.data.rooms, expiresAt: toDate(p.data.expiresAt) }, by);
  });
  return r.ok ? { ok: true } : r;
}

export async function removeMemberAction(userId: string): Promise<Result> {
  const r = await owner(async (by) => {
    const a = await requireOwner();
    if (a.userId === userId) throw new HomeAccessError("You cannot remove yourself");
    await removeMember(userId, by);
  });
  return r.ok ? { ok: true } : r;
}

const accountInput = z.object({
  email: z.email().max(200),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  role: inviteRoleSchema,
  rooms: roomGrantsSchema,
  expiresAt: expiry,
});

export async function createMemberAccountAction(input: z.input<typeof accountInput>): Promise<Result> {
  const p = accountInput.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input" };
  const r = await owner(async (by) => {
    try {
      await createMemberAccount({ ...p.data, expiresAt: toDate(p.data.expiresAt) }, by);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new Error("email_taken");
      throw e;
    }
  });
  return r.ok ? { ok: true } : r;
}

const inviteInput = z.object({ name: z.string().trim().min(1).max(64), role: inviteRoleSchema, rooms: roomGrantsSchema, accessExpiresAt: expiry });

export async function createInviteAction(input: z.input<typeof inviteInput>): Promise<Result<{ data: { id: string; token: string; expiresAt: string } }>> {
  const p = inviteInput.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  return owner(async (by) => {
    const r = await createInvite({ ...p.data, accessExpiresAt: toDate(p.data.accessExpiresAt) }, by);
    return { ...r, expiresAt: r.expiresAt.toISOString() };
  });
}

export async function revokeInviteAction(id: string): Promise<Result> {
  const r = await owner((by) => revokeInvite(id, by));
  return r.ok ? { ok: true } : r;
}

export async function bindDeviceAction(input: { deviceId: string; userId: string | null }): Promise<Result> {
  const p = z.object({ deviceId: z.string().min(1), userId: z.string().min(1).nullable() }).safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid input" };
  const r = await owner((by) => bindDevice(p.data.deviceId, p.data.userId, by));
  return r.ok ? { ok: true } : r;
}

// ---- public: the invitee side of /invite/<token> (no session yet)

const acceptInput = z.object({ token: z.string().min(16).max(128), email: z.email().max(200), displayName: z.string().trim().min(1).max(80), password: z.string().min(8).max(200) });

export async function acceptInviteAction(input: z.input<typeof acceptInput>): Promise<Result> {
  const demo = demoRefusal();
  if (demo) return demo;
  const p = acceptInput.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input" };
  if (!(await inviteByToken(p.data.token))) return { ok: false, error: "invalid" };
  const r = await acceptInvite(p.data.token, p.data);
  if (!r.ok) return { ok: false, error: r.error };
  await issueSessionForUser(r.userId);
  return { ok: true };
}
