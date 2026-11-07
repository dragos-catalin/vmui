"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, users } from "@/lib/db/schema";
import { getCurrentUser, verifyUserPassword } from "@/lib/auth";
import { demoRefusal } from "@/lib/demo/mode";
import {
  countBackupCodes,
  decryptTotpSecret,
  encryptBackupCodes,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  totpQrDataUrl,
  verifyTotpCode,
} from "@/lib/totp";

export interface TotpStatus {
  enrolled: boolean;
  verifiedAt: Date | null;
  backupCodesRemaining: number;
}

export async function getTotpStatusAction(): Promise<TotpStatus> {
  const me = await getCurrentUser();
  if (!me) return { enrolled: false, verifiedAt: null, backupCodesRemaining: 0 };
  return {
    enrolled: me.totpSecretEnc != null,
    verifiedAt: me.totpVerifiedAt,
    backupCodesRemaining: countBackupCodes(me.totpBackupCodesEnc),
  };
}

interface PendingEnrollment {
  userId: string;
  secret: string;
  expiresAt: number;
}
declare global {
  // eslint-disable-next-line no-var
  var __vmuiPendingTotpEnroll__: Map<string, PendingEnrollment> | undefined;
}
function pendingStore(): Map<string, PendingEnrollment> {
  if (!globalThis.__vmuiPendingTotpEnroll__) {
    globalThis.__vmuiPendingTotpEnroll__ = new Map();
  }
  return globalThis.__vmuiPendingTotpEnroll__;
}

export async function startTotpEnrollmentAction(): Promise<
  { ok: true; qrDataUrl: string; secret: string; enrollmentId: string }
  | { ok: false; error: string }
> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authenticated" };
  const secret = generateTotpSecret();
  const enrollmentId = crypto.randomUUID();
  pendingStore().set(enrollmentId, {
    userId: me.id,
    secret,
    expiresAt: Date.now() + 10 * 60_000,
  });
  // GC stale entries.
  for (const [k, v] of pendingStore()) {
    if (v.expiresAt < Date.now()) pendingStore().delete(k);
  }
  const qrDataUrl = await totpQrDataUrl(secret, me.email);
  return { ok: true, qrDataUrl, secret, enrollmentId };
}

export async function confirmTotpEnrollmentAction(input: {
  enrollmentId: string;
  code: string;
}): Promise<{ ok: true; backupCodes: string[] } | { ok: false; error: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authenticated" };
  const pending = pendingStore().get(input.enrollmentId);
  if (!pending || pending.userId !== me.id) {
    return { ok: false, error: "Enrollment expired. Start over." };
  }
  if (pending.expiresAt < Date.now()) {
    pendingStore().delete(input.enrollmentId);
    return { ok: false, error: "Enrollment expired. Start over." };
  }
  if (!verifyTotpCode(pending.secret, input.code)) {
    return { ok: false, error: "Code didn't match. Try the next one your app shows." };
  }
  pendingStore().delete(input.enrollmentId);

  const backupCodes = generateBackupCodes(10);
  await db
    .update(users)
    .set({
      totpSecretEnc: encryptTotpSecret(pending.secret),
      totpVerifiedAt: new Date(),
      totpBackupCodesEnc: encryptBackupCodes(backupCodes),
    })
    .where(eq(users.id, me.id));
  await db.insert(auditLog).values({
    action: "auth.totp.enroll",
    target: me.id,
    status: "ok",
  });
  revalidatePath("/settings/users");
  return { ok: true, backupCodes };
}

export async function disableTotpAction(input: {
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authenticated" };
  // Require fresh password proof so a stolen session can't silently disable 2FA.
  const r = await verifyUserPassword(me.email, input.password);
  if (!r.ok) return { ok: false, error: "Password incorrect" };
  await db
    .update(users)
    .set({ totpSecretEnc: null, totpVerifiedAt: null, totpBackupCodesEnc: null })
    .where(eq(users.id, me.id));
  await db.insert(auditLog).values({
    action: "auth.totp.disable",
    target: me.id,
    status: "ok",
  });
  revalidatePath("/settings/users");
  return { ok: true };
}

export async function regenerateBackupCodesAction(input: {
  password: string;
}): Promise<{ ok: true; codes: string[] } | { ok: false; error: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authenticated" };
  if (!me.totpSecretEnc) return { ok: false, error: "2FA not enrolled" };
  const r = await verifyUserPassword(me.email, input.password);
  if (!r.ok) return { ok: false, error: "Password incorrect" };
  const codes = generateBackupCodes(10);
  await db
    .update(users)
    .set({ totpBackupCodesEnc: encryptBackupCodes(codes) })
    .where(eq(users.id, me.id));
  await db.insert(auditLog).values({
    action: "auth.totp.backup-codes.regenerate",
    target: me.id,
    status: "ok",
  });
  revalidatePath("/settings/users");
  return { ok: true, codes };
}

/**
 * Test the user's current TOTP secret against a live code without disabling
 * or re-enrolling. Used by the settings UI to confirm the authenticator app
 * is still in sync.
 */
export async function pingTotpAction(input: { code: string }): Promise<{ ok: boolean }> {
  const me = await getCurrentUser();
  if (!me?.totpSecretEnc) return { ok: false };
  try {
    return { ok: verifyTotpCode(decryptTotpSecret(me.totpSecretEnc), input.code) };
  } catch {
    return { ok: false };
  }
}
