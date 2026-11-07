"use server";

import {
    authEnabled,
    signOut as authSignOut,
    createUser,
    getCurrentUser,
    hashPassword,
    issueSessionForUser,
    requireRole,
    signInWithPassword,
    userCount,
    verifyUserPassword,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLog, sessions, users } from "@/lib/db/schema";
import { demoRefusal } from "@/lib/demo/mode";
import { clearFailures, rateLimit, recordFailure } from "@/lib/rate-limit";
import { redactSecrets } from "@/lib/redact";
import { burnSetupCode, checkSetupCode } from "@/lib/setup-code";
import {
    consumeBackupCode,
    decryptTotpSecret,
    verifyTotpCode,
} from "@/lib/totp";
import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import "server-only";
import { z } from "zod";

interface PendingTotp {
  userId: string;
  expiresAt: number;
}
declare global {
  // eslint-disable-next-line no-var
  var __vmuiPendingTotp__: Map<string, PendingTotp> | undefined;
}
function pendingStore(): Map<string, PendingTotp> {
  if (!globalThis.__vmuiPendingTotp__) globalThis.__vmuiPendingTotp__ = new Map();
  return globalThis.__vmuiPendingTotp__;
}
function rememberPending(userId: string): string {
  const token = nanoid(32);
  pendingStore().set(token, { userId, expiresAt: Date.now() + 5 * 60_000 });
  return token;
}
function consumePending(token: string): string | null {
  const store = pendingStore();
  const p = store.get(token);
  if (!p) return null;
  store.delete(token);
  if (p.expiresAt < Date.now()) return null;
  return p.userId;
}

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export type SignInState =
  | { error?: string; pending2FA?: string; pendingEmail?: string }
  | undefined;

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local"
  );
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const ip = await clientIp();
  // 10 attempts / 5 min per IP. Cheap DoS shield, plenty of headroom for typos.
  const rl = rateLimit(`signin:${ip}`, 10, 300);
  if (!rl.ok) {
    await db.insert(auditLog).values({
      action: "auth.sign-in.rate-limited",
      target: ip,
      status: "error",
      message: `try again in ${rl.resetInSec}s`,
    });
    return { error: `Too many attempts. Try again in ${rl.resetInSec}s.` };
  }

  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter a valid email and password" };

  const failKey = `signin:${parsed.data.email.toLowerCase()}`;
  const r = await verifyUserPassword(parsed.data.email, parsed.data.password);
  if (!r.ok) {
    const { delayMs } = recordFailure(failKey);
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    await db.insert(auditLog).values({
      action: "auth.sign-in",
      target: parsed.data.email,
      status: "error",
      message: redactSecrets(r.error),
    });
    return { error: r.error };
  }
  clearFailures(failKey);

  // If 2FA is enabled, gate session creation behind the TOTP step.
  if (r.user.totpSecretEnc && r.user.totpVerifiedAt) {
    const token = rememberPending(r.user.id);
    await db.insert(auditLog).values({
      action: "auth.sign-in.2fa-required",
      target: r.user.email,
      status: "ok",
    });
    return { pending2FA: token, pendingEmail: r.user.email };
  }

  await issueSessionForUser(r.user.id);
  await db.insert(auditLog).values({
    action: "auth.sign-in",
    target: r.user.email,
    status: "ok",
  });
  redirect("/");
}

const verifyTotpSchema = z.object({
  token: z.string().min(8),
  code: z.string().min(6).max(20),
});

export async function verifyTotpAction(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = verifyTotpSchema.safeParse({
    token: formData.get("token"),
    code: formData.get("code"),
  });
  if (!parsed.success) return { error: "Enter the 6-digit code" };
  const userId = consumePending(parsed.data.token);
  if (!userId) return { error: "Verification expired. Sign in again." };

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { error: "User not found" };
  if (!user.totpSecretEnc) return { error: "2FA not enrolled" };

  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEnc);
  } catch {
    return { error: "Could not decrypt 2FA secret" };
  }
  const code = parsed.data.code.trim();

  // Try TOTP first; fall back to backup code on failure.
  let ok = verifyTotpCode(secret, code);
  let usedBackup = false;
  if (!ok) {
    const r = consumeBackupCode(user.totpBackupCodesEnc, code);
    if (r.ok) {
      ok = true;
      usedBackup = true;
      await db.update(users).set({ totpBackupCodesEnc: r.newEnc }).where(eq(users.id, user.id));
    }
  }
  if (!ok) {
    const { delayMs } = recordFailure(`totp:${user.id}`);
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    // Re-issue a token so the user can retry without re-entering the password.
    const token = rememberPending(user.id);
    await db.insert(auditLog).values({
      action: "auth.totp.verify",
      target: user.email,
      status: "error",
    });
    return { error: "Invalid code.", pending2FA: token, pendingEmail: user.email };
  }
  clearFailures(`totp:${user.id}`);
  await issueSessionForUser(user.id);
  await db.insert(auditLog).values({
    action: "auth.sign-in",
    target: user.email,
    status: "ok",
    message: usedBackup ? "totp+backup" : "totp",
  });
  redirect("/");
}

const signUpSchema = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "operator", "viewer"]).default("admin"),
  setupCode: z.string().max(12).optional(),
});

export type SignUpState = { error?: string } | undefined;

export async function signUpAction(_prev: SignUpState, formData: FormData): Promise<SignUpState> {
  const demo = demoRefusal();
  if (demo) return { error: demo.error };
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    displayName: formData.get("displayName"),
    password: formData.get("password"),
    role: formData.get("role") ?? "admin",
    setupCode: formData.get("setupCode") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };

  const isFirst = (await userCount()) === 0;
  if (isFirst) {
    // Claiming the hub needs the code from the log / SD card / attached screen (physical access).
    const check = checkSetupCode(parsed.data.setupCode ?? "");
    if (check === "locked") return { error: "setup_code_locked" };
    if (check === "wrong") return { error: "setup_code_wrong" };
  } else {
    // After the first user is bootstrapped, only admins can create more.
    await requireRole("admin");
  }
  const role = isFirst ? "admin" : parsed.data.role;
  try {
    const user = await createUser({
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      password: parsed.data.password,
      role,
    });
    await db.insert(auditLog).values({
      action: "auth.user.create",
      target: user.email,
      status: "ok",
      message: role,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to create user" };
  }

  if (isFirst) {
    burnSetupCode();
    // bootstrap: sign the new admin straight in
    await signInWithPassword(parsed.data.email, parsed.data.password);
    redirect("/");
  }
  redirect("/settings/users");
}

export async function signOutAction(): Promise<void> {
  const u = await getCurrentUser();
  await authSignOut();
  if (u) {
    await db.insert(auditLog).values({
      action: "auth.sign-out",
      target: u.email,
      status: "ok",
    });
  }
  redirect("/sign-in");
}

export async function deleteUserAction(userId: string): Promise<{ ok: boolean; error?: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await requireRole("admin");
  if (!me) return { ok: false, error: "Auth not enabled" };
  if (me.id === userId) return { ok: false, error: "You cannot delete yourself" };
  const { users } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(auditLog).values({
    action: "auth.user.delete",
    target: userId,
    status: "ok",
  });
  return { ok: true };
}

const updateRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["admin", "operator", "viewer"]),
});

export async function updateUserRoleAction(
  input: z.infer<typeof updateRoleSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await requireRole("admin");
  if (!me) return { ok: false, error: "Auth not enabled" };
  const parsed = updateRoleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  if (me.id === parsed.data.userId && parsed.data.role !== "admin") {
    return { ok: false, error: "You cannot demote yourself" };
  }
  const { users } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(users).set({ role: parsed.data.role }).where(eq(users.id, parsed.data.userId));
  await db.insert(auditLog).values({
    action: "auth.user.role",
    target: parsed.data.userId,
    status: "ok",
    message: parsed.data.role,
  });
  return { ok: true };
}

const adminResetPasswordSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(8).max(200).optional(),
});

export async function adminResetPasswordAction(
  input: z.infer<typeof adminResetPasswordSchema>,
): Promise<{ ok: true; password?: string } | { ok: false; error: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await requireRole("admin");
  if (!me) return { ok: false, error: "settings.users.resetPassword.errors.generic" };
  const parsed = adminResetPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "settings.users.resetPassword.errors.short" };
  const target = await db.query.users.findFirst({ where: eq(users.id, parsed.data.userId) });
  if (!target) return { ok: false, error: "settings.users.resetPassword.errors.notFound" };
  // Own password goes through changeMyPasswordAction (proves the current one, keeps this session).
  if (target.id === me.id) return { ok: false, error: "settings.users.resetPassword.errors.self" };

  const generated = parsed.data.password === undefined;
  const password = parsed.data.password ?? randomBytes(12).toString("base64url").slice(0, 16);
  const passwordHash = await hashPassword(password);
  await db.update(users).set({ passwordHash }).where(eq(users.id, target.id));
  await db.delete(sessions).where(eq(sessions.userId, target.id));
  await db.insert(auditLog).values({
    action: "auth.user.password-reset",
    target: target.email,
    status: "ok",
    message: generated ? "generated" : "set by admin",
  });
  revalidatePath("/settings/users");
  return generated ? { ok: true, password } : { ok: true };
}

const changeMyPasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(200),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { path: ["newPassword"], message: "same" });

export async function changeMyPasswordAction(
  input: z.infer<typeof changeMyPasswordSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const demo = demoRefusal();
  if (demo) return demo;
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "settings.security.password.errors.generic" };
  const parsed = changeMyPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const same = parsed.error.issues.some((i) => i.message === "same");
    return { ok: false, error: same ? "settings.security.password.errors.same" : "settings.security.password.errors.short" };
  }
  const r = await verifyUserPassword(me.email, parsed.data.currentPassword);
  if (!r.ok) {
    await db.insert(auditLog).values({
      action: "auth.password.change",
      target: me.email,
      status: "error",
      message: "wrong current password",
    });
    return { ok: false, error: "settings.security.password.errors.wrongPassword" };
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, me.id));
  const currentSid = (await cookies()).get("vmui_session")?.value ?? "";
  await db.delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, currentSid)));
  await db.insert(auditLog).values({
    action: "auth.password.change",
    target: me.email,
    status: "ok",
  });
  revalidatePath("/settings/users");
  return { ok: true };
}

export async function authStatusAction(): Promise<{ enabled: boolean }> {
  return { enabled: await authEnabled() };
}
