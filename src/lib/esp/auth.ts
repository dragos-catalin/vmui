import { db } from "@/lib/db";
import { pairedDevices } from "@/lib/db/schema";
import { parseScopes, pathInScopes } from "@/lib/devices/appliance-scopes";
import { credential } from "@/lib/home/credentials";
import { eq } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import "server-only";

// Two ways in for the non-browser clients:
//   ?k= / x-esp-token  — the shared ESP_DISPLAY_TOKEN from .private/credentials.env
//                        (ESP32, Nest Hub kiosk, hub-cast, HA rest_command).
//   Authorization: Bearer vmd_… / ?d=  — a per-device token: the phone/desktop
//                        apps (pairing flow) or an appliance token minted by the
//                        owner, limited to its profile's path prefixes.
// better-sqlite3 is synchronous, so the device lookup keeps this function sync.
export function espAuthorized(req: Request): boolean {
  const url = new URL(req.url);
  const want = credential("ESP_DISPLAY_TOKEN");
  const k = url.searchParams.get("k") ?? req.headers.get("x-esp-token") ?? "";
  if (want && k) {
    const a = Buffer.from(k);
    const b = Buffer.from(want);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  const auth = req.headers.get("authorization") ?? "";
  const d = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("d") ?? "";
  if (!d.startsWith("vmd_")) return false;
  const hash = createHash("sha256").update(d).digest("hex");
  const row = db.select({ id: pairedDevices.id, status: pairedDevices.status, scopes: pairedDevices.scopes }).from(pairedDevices).where(eq(pairedDevices.tokenHash, hash)).get();
  if (!row || row.status !== "approved") return false;
  const scopes = parseScopes(row.scopes);
  if (scopes && !pathInScopes(url.pathname, scopes)) return false;
  touch(row.id, req);
  return true;
}

/** Approved paired-device id behind `Bearer vmd_…` / `?d=`, or null when the caller
 *  used the shared token (or nothing). Lets a route tell "owner's hardware" from
 *  "a family member's phone" — the latter carries its own permissions. */
export function deviceIdFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const d = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("d") ?? "";
  if (!d.startsWith("vmd_")) return null;
  const hash = createHash("sha256").update(d).digest("hex");
  const row = db.select({ id: pairedDevices.id, status: pairedDevices.status }).from(pairedDevices).where(eq(pairedDevices.tokenHash, hash)).get();
  return row && row.status === "approved" ? row.id : null;
}

const seen = new Map<string, number>();
function touch(id: string, req: Request) {
  const now = Date.now();
  if (now - (seen.get(id) ?? 0) < 60_000) return;
  seen.set(id, now);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  db.update(pairedDevices).set({ lastSeenAt: new Date(), lastIp: ip }).where(eq(pairedDevices.id, id)).run();
}
