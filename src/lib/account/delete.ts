import "server-only";

import { aiConsentKey } from "@/lib/ai/consent";
import { db } from "@/lib/db";
import { auditLog, homeMembers, hydration, meals, nutritionProfiles, pairedDevices, pushSubscriptions, secretReveals, settings, terminalRecordings, users } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";

export type DeleteRefusal = "owner" | "lastAdmin" | "notFound";

/** Why this account may not delete itself, or null when it may. The household owner and the last
 *  infrastructure admin cannot: their departure would leave the hub with nobody in charge, so the
 *  page points them to a factory reset instead. */
export async function deletionRefusal(userId: string): Promise<DeleteRefusal | null> {
  const u = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!u) return "notFound";
  const m = await db.select({ role: homeMembers.role }).from(homeMembers).where(eq(homeMembers.userId, userId)).get();
  if (m?.role === "owner") return "owner";
  if (!m && u.role === "admin") return "owner"; // an admin without a member row acts as owner (lib/home/access.ts)
  if (u.role === "admin") {
    const others = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), ne(users.id, userId))).limit(1);
    if (others.length === 0) return "lastAdmin";
  }
  return null;
}

/**
 * Erases one member's personal data from the hub. Sessions, passkeys, team rows and the member row
 * go by `ON DELETE CASCADE`; tables with a plain `user_id` are cleared here; paired devices are
 * revoked and stripped of push tokens. The audit log keeps the event with the user id only
 * (security record, rotated after 30 days by lib/audit-retention.ts).
 */
export async function eraseAccount(userId: string): Promise<{ email: string }> {
  const u = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw new Error("not found");
  db.transaction((tx) => {
    tx.delete(meals).where(eq(meals.userId, userId)).run();
    tx.delete(hydration).where(eq(hydration.userId, userId)).run();
    tx.delete(nutritionProfiles).where(eq(nutritionProfiles.userId, userId)).run();
    tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run();
    tx.update(secretReveals).set({ userId: null }).where(eq(secretReveals.userId, userId)).run();
    tx.update(terminalRecordings).set({ userId: null }).where(eq(terminalRecordings.userId, userId)).run();
    tx.update(pairedDevices)
      .set({ status: "revoked", userId: null, pushToken: null, pushActivity: null, pushKey: null, pushP256dh: null, pushAuth: null, lastIp: null })
      .where(eq(pairedDevices.userId, userId))
      .run();
    tx.delete(settings).where(eq(settings.key, aiConsentKey(userId))).run();
    tx.delete(users).where(eq(users.id, userId)).run();
    tx.insert(auditLog).values({ action: "auth.account.delete", target: userId, status: "ok", message: "self-service" }).run();
  });
  return { email: u.email };
}
