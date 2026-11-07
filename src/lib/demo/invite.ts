import "server-only";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { isDemo } from "./mode";

/** Reviewer account of the demo hub (CONTRACT.md "Demo hub"). */
export const DEMO_REVIEWER_EMAIL = "review@vatra.dragoscatalin.ro";

const INVITE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The static invite from VATRA_DEMO_INVITE, or null when unset / malformed / not a demo hub. */
export function demoInvite(): string | null {
  if (!isDemo()) return null;
  const v = process.env.VATRA_DEMO_INVITE?.trim() ?? "";
  return INVITE_RE.test(v) ? v : null;
}

/** Static invite: redeemable any number of times, always pairs as the reviewer. Null otherwise. */
export async function redeemDemoInvite(code: string): Promise<{ userId: string; email: string } | null> {
  const inv = demoInvite();
  if (!inv) return null;
  const a = Buffer.from(code);
  const b = Buffer.from(inv);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const u = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, DEMO_REVIEWER_EMAIL)).get();
  return u ? { userId: u.id, email: u.email } : null;
}
