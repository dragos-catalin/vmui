"use server";

import "server-only";

import { deletionRefusal, eraseAccount } from "@/lib/account/delete";
import { getCurrentUser, verifyUserPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { demoRefusal } from "@/lib/demo/mode";
import { rateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import { z } from "zod";

const ERR = "legal.accountCard.errors";

const schema = z.object({ password: z.string().min(1).max(200) });

/** Self-service account deletion for a household member (Play / App Store / GDPR art. 17).
 *  The owner is refused: deleting the owner means resetting the hub. */
export async function deleteMyAccountAction(input: z.input<typeof schema>): Promise<{ ok: true } | { ok: false; error: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: `${ERR}.generic` };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `${ERR}.password` };
  if (!rateLimit(`account-delete:${me.id}`, 5, 15 * 60).ok) return { ok: false, error: `${ERR}.rateLimited` };

  const refusal = await deletionRefusal(me.id);
  if (refusal) {
    await db.insert(auditLog).values({ action: "auth.account.delete", target: me.id, status: "error", message: `refused: ${refusal}` });
    return { ok: false, error: `${ERR}.${refusal === "notFound" ? "generic" : refusal}` };
  }
  const check = await verifyUserPassword(me.email, parsed.data.password);
  if (!check.ok) {
    await db.insert(auditLog).values({ action: "auth.account.delete", target: me.id, status: "error", message: "wrong password" });
    return { ok: false, error: `${ERR}.wrongPassword` };
  }
  await eraseAccount(me.id);
  (await cookies()).delete("vmui_session");
  return { ok: true };
}

/** Whether the signed-in user can delete their own account (drives the settings card). */
export async function myDeletionStatusAction(): Promise<{ canDelete: boolean; reason: "owner" | "lastAdmin" | null }> {
  const me = await getCurrentUser();
  if (!me) return { canDelete: false, reason: null };
  const r = await deletionRefusal(me.id);
  return r === null ? { canDelete: true, reason: null } : { canDelete: false, reason: r === "notFound" ? null : r };
}
