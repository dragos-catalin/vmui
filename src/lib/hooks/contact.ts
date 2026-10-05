import { contactHookNonces } from "@/lib/db/schema";
import { inArray, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import "server-only";
import { z } from "zod";

// Inbound contact-form webhook from dragoscatalin.ro (Vercel server action),
// reached through a Tailscale Funnel that exposes only /hooks/contact.
// Signature: hex HMAC-SHA256(CONTACT_HOOK_SECRET, `${x-dc-timestamp}.${rawBody}`).
// Replay keys are the nonce AND the signature: the nonce header is not signed,
// so a captured request re-sent with a fresh nonce still hits the signature key.

export const MAX_SKEW_SEC = 300;
export const REPLAY_TTL_SEC = 2 * MAX_SKEW_SEC;
export const MAX_BODY_BYTES = 16 * 1024;
export const PREVIEW_CHARS = 280;

export const contactPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  subject: z.string().trim().max(300).optional(),
  message: z.string().trim().min(1).max(10_000),
  locale: z.string().trim().min(2).max(16),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type ContactPayload = z.infer<typeof contactPayloadSchema>;

export type ContactHookDeps = {
  secret: () => string | undefined;
  nowMs: () => number;
  /** false when the caller is over its budget */
  limit: (source: string) => boolean;
  /** atomically record every key; false when any was already seen */
  claim: (keys: string[], nowSec: number) => boolean;
  deliver: (p: ContactPayload & { preview: string; nonce: string }) => Promise<void>;
};

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function preview(message: string): string {
  const chars = Array.from(message.replace(/\s+/g, " ").trim());
  return chars.length <= PREVIEW_CHARS ? chars.join("") : `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…`;
}

function safeEqualHex(got: string, want: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  const a = Buffer.from(got.toLowerCase(), "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const err = (status: number, error: string, headers?: Record<string, string>) => Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Last X-Forwarded-For hop: the one appended by Tailscale Serve. Earlier hops are client-controlled. */
export function sourceOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function handleContactHook(req: Request, deps: ContactHookDeps): Promise<Response> {
  const secret = deps.secret();
  if (!secret) return err(503, "not_configured");
  if (!deps.limit(sourceOf(req))) return err(429, "rate_limited", { "Retry-After": "60" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return err(413, "too_large");
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return err(413, "too_large");

  const ts = req.headers.get("x-dc-timestamp") ?? "";
  const sig = req.headers.get("x-dc-signature") ?? "";
  const nonce = req.headers.get("x-dc-nonce") ?? "";
  if (!/^\d{1,12}$/.test(ts) || !sig) return err(401, "missing_signature");
  const nowSec = Math.floor(deps.nowMs() / 1000);
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SEC) return err(401, "stale_timestamp");
  if (!safeEqualHex(sig, sign(secret, ts, raw))) return err(401, "bad_signature");
  if (!z.uuid().safeParse(nonce).success) return err(400, "bad_nonce");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err(400, "bad_json");
  }
  const parsed = contactPayloadSchema.safeParse(json);
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_body", fields: Object.keys(z.flattenError(parsed.error).fieldErrors) }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const sigKey = `s:${createHash("sha256").update(sig.toLowerCase()).digest("hex")}`;
  if (!deps.claim([`n:${nonce.toLowerCase()}`, sigKey], nowSec)) return err(409, "replayed");

  await deps.deliver({ ...parsed.data, preview: preview(parsed.data.message), nonce });
  return Response.json({ ok: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}

/** Insert every replay key or none; purges expired rows first. Sync: better-sqlite3. */
export function claimReplayKeys<T extends Record<string, unknown>>(d: BetterSQLite3Database<T>, keys: string[], nowSec: number, ttlSec = REPLAY_TTL_SEC): boolean {
  return d.transaction((tx) => {
    tx.delete(contactHookNonces).where(lt(contactHookNonces.expiresAt, new Date(nowSec * 1000))).run();
    const seen = tx.select({ key: contactHookNonces.key }).from(contactHookNonces).where(inArray(contactHookNonces.key, keys)).all();
    if (seen.length > 0) return false;
    const expiresAt = new Date((nowSec + ttlSec) * 1000);
    tx.insert(contactHookNonces).values(keys.map((key) => ({ key, expiresAt }))).run();
    return true;
  });
}
