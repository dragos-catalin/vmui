import { db } from "@/lib/db";
import { auditLog, pairedDevices } from "@/lib/db/schema";
import { applianceEnvKey, parseScopes, pathInScopes, type ApplianceProfile } from "@/lib/devices/appliance-scopes";
import { kioskCookieFrom, redeemLinkCode } from "@/lib/display/kiosk-session";
import { credential } from "@/lib/home/credentials";
import { eq } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import "server-only";

// Ways in for the non-browser clients:
//   Authorization: Bearer vmd_…  — a per-device token: the phone/desktop apps (pairing flow) or an
//                                  appliance token (owner-minted, limited to its profile's paths).
//   x-esp-token                  — the legacy shared ESP_DISPLAY_TOKEN (deprecated, P0-06).
//   vatra_kiosk cookie           — the Nest Hub, which loads a URL and cannot send headers; set by
//                                  /api/display/session from a one-time code, valid on kiosk paths only.
//   ?once=<code>                 — one-time link code bound to this exact path (APK download from a
//                                  phone browser), minted by POST /api/devices/link.
//   ?d= / ?k= query              — deprecated (tokens end up in logs and history). Accepted until
//                                  VATRA_QUERY_TOKENS=0; every use is audited once per path per hour.
// better-sqlite3 is synchronous, so the device lookup keeps this function sync.

const KIOSK_PATHS = ["/display", "/api/display/", "/api/turzx/state", "/api/home/events"];
export const queryTokensAllowed = (): boolean => process.env.VATRA_QUERY_TOKENS !== "0";

const resolved = new WeakMap<Request, string>();

/** The credential a request carries, from the first source that has one. Memoised per request:
 *  a one-time code is redeemed once even though auth and actor lookups each ask. */
export function requestCredential(req: Request): string {
  const hit = resolved.get(req);
  if (hit !== undefined) return hit;
  const c = resolveCredential(req);
  resolved.set(req, c);
  return c;
}

function resolveCredential(req: Request): string {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const x = req.headers.get("x-esp-token");
  if (x) return x;
  if (pathInScopes(url.pathname, KIOSK_PATHS)) {
    const c = kioskCookieFrom(req);
    if (c) return c;
  }
  const once = url.searchParams.get("once");
  if (once) return redeemLinkCode(once, url.pathname) ?? "";
  if (!queryTokensAllowed()) return "";
  const q = url.searchParams.get("d") ?? url.searchParams.get("k");
  if (q) noteQueryToken(url.pathname);
  return q ?? "";
}

const sharedMatches = (t: string): boolean => {
  const want = credential("ESP_DISPLAY_TOKEN");
  if (!want || !t) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function espAuthorized(req: Request): boolean {
  const d = requestCredential(req);
  if (sharedMatches(d)) return true;
  if (!d.startsWith("vmd_")) return false;
  const url = new URL(req.url);
  const hash = createHash("sha256").update(d).digest("hex");
  const row = db.select({ id: pairedDevices.id, status: pairedDevices.status, scopes: pairedDevices.scopes }).from(pairedDevices).where(eq(pairedDevices.tokenHash, hash)).get();
  if (!row || row.status !== "approved") return false;
  const scopes = parseScopes(row.scopes);
  if (scopes && !pathInScopes(url.pathname, scopes)) return false;
  touch(row.id, req);
  return true;
}

/** Headers for a loopback call made on behalf of an appliance: its provisioned token
 *  (scripts/appliance-tokens.mjs) as a Bearer, else the legacy shared token. Never in the URL. */
export function applianceAuthHeaders(profile: ApplianceProfile): Record<string, string> {
  const own = credential(applianceEnvKey(profile));
  if (own?.startsWith("vmd_")) return { authorization: `Bearer ${own}` };
  const shared = credential("ESP_DISPLAY_TOKEN");
  return shared ? { "x-esp-token": shared } : {};
}

/** The caller's own credential, to forward on a loopback call (display/state -> turzx/state). */
export function forwardedAuthHeaders(req: Request): Record<string, string> {
  const c = requestCredential(req);
  if (!c) return {};
  return c.startsWith("vmd_") ? { authorization: `Bearer ${c}` } : { "x-esp-token": c };
}

/** Approved paired-device id behind `Bearer vmd_…` / `?d=`, or null when the caller
 *  used the shared token (or nothing). Lets a route tell "owner's hardware" from
 *  "a family member's phone" — the latter carries its own permissions. */
export function deviceIdFromRequest(req: Request): string | null {
  const d = requestCredential(req);
  if (!d.startsWith("vmd_")) return null;
  const hash = createHash("sha256").update(d).digest("hex");
  const row = db.select({ id: pairedDevices.id, status: pairedDevices.status }).from(pairedDevices).where(eq(pairedDevices.tokenHash, hash)).get();
  return row && row.status === "approved" ? row.id : null;
}

const seen = new Map<string, number>();
const queryNoted = new Map<string, number>();
/** Who still sends a token in the URL: one audit row per path per hour, so P0-06 can be closed on data. */
function noteQueryToken(path: string) {
  const now = Date.now();
  if (now - (queryNoted.get(path) ?? 0) < 3_600_000) return;
  queryNoted.set(path, now);
  try {
    db.insert(auditLog).values({ accountId: "devices", action: "auth.query_token", target: path, status: "error", message: "deprecated: token sent in the URL; move the client to the Authorization header" }).run();
  } catch {
    // telemetry only: a failed audit write must not decide authentication
  }
}

function touch(id: string, req: Request) {
  const now = Date.now();
  if (now - (seen.get(id) ?? 0) < 60_000) return;
  seen.set(id, now);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  db.update(pairedDevices).set({ lastSeenAt: new Date(), lastIp: ip }).where(eq(pairedDevices.id, id)).run();
}
