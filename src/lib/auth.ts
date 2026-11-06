import "server-only";

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { eq, gt, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { users, sessions, type UserRow, type UserRole } from "@/lib/db/schema";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const COOKIE_NAME = "vmui_session";

/** True when the browser reached us over HTTPS: directly or through Caddy / the relay
 *  (x-forwarded-proto). Plain-HTTP LAN access (vatra.local:3737) keeps a non-Secure
 *  cookie, otherwise the browser would drop it and sign-in would loop. */
async function requestIsHttps(): Promise<boolean> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  return (h.get("origin") ?? h.get("referer") ?? "").startsWith("https://");
}
const SESSION_DAYS = 30;

export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const got = await scryptAsync(password, salt, expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function userCount(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  password: string;
  role: UserRole;
}): Promise<UserRow> {
  const id = nanoid();
  const passwordHash = await hashPassword(input.password);
  await db.insert(users).values({
    id,
    email: input.email.toLowerCase(),
    displayName: input.displayName,
    passwordHash,
    role: input.role,
  });
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!row) throw new Error("Failed to create user");
  return row;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ ok: true; user: UserRow } | { ok: false; error: string }> {
  const row = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (!row) return { ok: false, error: "Invalid email or password" };
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return { ok: false, error: "Invalid email or password" };
  await issueSessionForUser(row.id);
  return { ok: true, user: row };
}

/**
 * Verify the password without issuing a session cookie. Used by the 2FA flow
 * which needs to gate session creation on a second-factor check.
 */
export async function verifyUserPassword(
  email: string,
  password: string,
): Promise<{ ok: true; user: UserRow } | { ok: false; error: string }> {
  const row = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (!row) return { ok: false, error: "Invalid email or password" };
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return { ok: false, error: "Invalid email or password" };
  return { ok: true, user: row };
}

/** Issue and set a session cookie for the given user. */
export async function issueSessionForUser(userId: string): Promise<void> {
  const sessionId = nanoid(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: sessionId, userId, expiresAt });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const jar = await cookies();
  jar.set(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: await requestIsHttps(),
    expires: expiresAt,
  });
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const c = jar.get(COOKIE_NAME);
  if (c) {
    await db.delete(sessions).where(eq(sessions.id, c.value));
    jar.delete(COOKIE_NAME);
  }
}

export async function getCurrentUser(): Promise<UserRow | null> {
  if ((await userCount()) === 0) return null;
  const jar = await cookies();
  const c = jar.get(COOKIE_NAME);
  if (!c) return null;
  const row = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, c.value), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const hit = row[0];
  if (!hit) return null;
  // refresh last-seen
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, hit.sessionId));
  return hit.user;
}

export async function authEnabled(): Promise<boolean> {
  return (await userCount()) > 0;
}

export async function requireRole(min: UserRole): Promise<UserRow | null> {
  if (!(await authEnabled())) return null;
  const u = await getCurrentUser();
  if (!u) throw new Error("Not authenticated");
  if (ROLE_RANK[u.role] < ROLE_RANK[min]) {
    throw new Error(`Role '${min}' required (you are '${u.role}')`);
  }
  return u;
}
