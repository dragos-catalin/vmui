import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Some clients can only open a URL: the Nest Hub (DashCast) and a phone's browser downloading the
 * APK. Their token must not ride in that URL (P0-06). A header-authenticated caller mints a
 * one-time code bound to ONE path (POST /api/devices/link, hub-cast, the owner's server action):
 *   - /display: /api/display/session?code= swaps it for an httpOnly cookie valid on kiosk paths;
 *   - anything else: <path>?once=<code>, redeemed by lib/esp/auth.ts for that path only.
 * Codes live 5 minutes, in memory, and work once.
 */

export const KIOSK_COOKIE = "vatra_kiosk";
const TTL_MS = 5 * 60_000;

type Entry = { credential: string; path: string; exp: number };
const g = globalThis as { __vatraLinkCodes__?: Map<string, Entry> };
const codes = (g.__vatraLinkCodes__ ??= new Map());

function sweep(now: number) {
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
}

/** `credential` = the caller's vmd_ token (or, during the deprecation window, the shared token). */
export function mintLinkCode(credential: string, path: string): string {
  const now = Date.now();
  sweep(now);
  const code = randomBytes(18).toString("base64url");
  codes.set(code, { credential, path, exp: now + TTL_MS });
  return code;
}

export const mintKioskCode = (credential: string): string => mintLinkCode(credential, "/display");

/** Single use, and only for the path it was minted for. */
export function redeemLinkCode(code: string, path: string): string | null {
  const e = codes.get(code);
  if (!e) return null;
  codes.delete(code);
  return e.exp >= Date.now() && e.path === path ? e.credential : null;
}

export const redeemKioskCode = (code: string): string | null => redeemLinkCode(code, "/display");

export function kioskCookieFrom(req: Request): string | null {
  const m = /(?:^|;\s*)vatra_kiosk=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
