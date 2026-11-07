import "server-only";
import { cloudEndpoints, hubJwt } from "@/lib/cloud/identity";
import { credential } from "@/lib/home/credentials";
import { createCipheriv, randomBytes } from "node:crypto";
import type { LocalizedCard } from "./index";
import { upPayload } from "./unifiedpush";

// Vatra Cloud push relay (docs/product/cloud/CONTRACT.md § Push relay): the hub hands the relay an opaque
// handle and an end-to-end sealed card; the relay turns it into APNs / FCM. Only the platform token, hub id,
// card id, kind, priority and timing are visible outside the hub and the phone — never card text.

export type RelayPlatform = "apns" | "apns-sandbox" | "fcm";
export type RelayTarget = { handle: string; activityHandle?: string | null; key: Buffer };
export type RelayBody = {
  handle: string;
  type: "alert" | "background" | "liveactivity";
  priority: "high" | "normal";
  critical: boolean;
  collapse: string;
  ttl: number;
  kind: string;
  data: { v: "1"; id: string; e: string; full: "1" | "0"; type: "card" | "dismiss" };
  activity?: { event: "start"; attributesType: "IntercomAttributes"; attributes: { cardId: string }; state: { ringing: boolean; since: number; e: string } };
};
export type RelayResult = { status: number; gone?: boolean };
export type RelaySend = (body: RelayBody) => Promise<RelayResult>;

/** The plaintext of `e` stays under this; bigger cards go minimal and the app fetches the rest. */
const MAX_PLAIN = 2800;

/** Owner toggle (Settings → Vatra Cloud) stored as an integration credential. */
export function relayEnabled(): boolean {
  return credential("VATRA_CLOUD_PUSH") === "1";
}

/** b64url(nonce12 ‖ AES-256-GCM ciphertext ‖ tag16), aad = UTF-8 card id. */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
}

export function sealCard(card: LocalizedCard, key: Buffer): { e: string; full: "1" | "0" } {
  let plain = upPayload(card);
  let full: "1" | "0" = "1";
  if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN) {
    plain = JSON.stringify({ type: card.dismissedAt ? "dismiss" : "card", id: card.id, kind: card.kind, tag: card.tag ?? "", priority: card.priority, at: String(card.updatedAt.getTime()), fetch: "1" });
    full = "0";
  } else if ((JSON.parse(plain) as { fetch?: string }).fetch === "1") full = "0";
  return { e: seal(plain, key, card.id), full };
}

/** The POST /v1/push bodies for one device: alert (or background for a dismiss), plus the intercom Live Activity. */
export function relayRequests(card: LocalizedCard, t: RelayTarget): RelayBody[] {
  const { e, full } = sealCard(card, t.key);
  const collapse = (card.tag ?? card.id).slice(0, 64);
  const urgent = card.priority === "high" || card.priority === "urgent";
  const dismissed = Boolean(card.dismissedAt);
  const data: RelayBody["data"] = { v: "1", id: card.id, e, full, type: dismissed ? "dismiss" : "card" };
  const base = { critical: false, collapse, ttl: 3600, kind: card.kind, data };
  if (dismissed) return [{ handle: t.handle, type: "background", priority: "normal", ...base }];
  const out: RelayBody[] = [{ handle: t.handle, type: "alert", priority: urgent ? "high" : "normal", ...base }];
  if (card.kind === "intercom" && urgent && t.activityHandle) {
    const small = JSON.stringify({ canOpen: card.actions.some((a) => a.id === "open"), door: card.subtitle ?? "" });
    out.push({
      handle: t.activityHandle,
      type: "liveactivity",
      priority: "high",
      ...base,
      ttl: 300,
      activity: {
        event: "start",
        attributesType: "IntercomAttributes",
        attributes: { cardId: card.id },
        state: { ringing: true, since: Math.floor(card.updatedAt.getTime() / 1000), e: seal(small, t.key, card.id) },
      },
    });
  }
  return out;
}

export const defaultSend: RelaySend = async (body) => {
  try {
    const res = await fetch(`${cloudEndpoints().api}/v1/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${hubJwt("vatra-push")}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { status: res.status };
    const j = (await res.json().catch(() => ({}))) as { status?: number; gone?: boolean };
    return { status: j.status ?? res.status, gone: j.gone === true };
  } catch {
    return { status: 0 };
  }
};

/** Sends the card to every device through the relay; returns the handles the relay reports gone. */
export async function sendRelay(targets: RelayTarget[], card: LocalizedCard, send: RelaySend = defaultSend): Promise<string[]> {
  const gone: string[] = [];
  await Promise.all(
    targets.map(async (t) => {
      for (const body of relayRequests(card, t)) {
        const r = await send(body);
        if (r.gone || r.status === 410) gone.push(body.handle);
        else if (r.status !== 200) console.warn("[vmui] push relay", r.status, body.type);
      }
    }),
  );
  return gone;
}
