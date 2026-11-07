import { credential } from "@/lib/home/credentials";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import "server-only";
import type { LocalizedCard } from "./index";

// FCM HTTP v1 with a service-account key (.private/fcm-service-account.json,
// role Firebase Cloud Messaging API Admin on the vmui Firebase project).
// Data-only messages: the app builds the rich notification itself (colour,
// icon, image, progress, actions) and acks back — a "notification" payload
// would let the OS draw a plain card we cannot control. No googleapis SDK:
// one JWT + one token exchange, cached until 5 min before expiry.

type Sa = { client_email: string; private_key: string; project_id: string };
let sa: Sa | null | undefined;
let token: { value: string; exp: number } | null = null;

function account(): Sa | null {
  if (sa !== undefined) return sa;
  const p = credential("FCM_SERVICE_ACCOUNT") ?? path.join(process.cwd(), ".private", "fcm-service-account.json");
  try {
    sa = JSON.parse(readFileSync(p, "utf8")) as Sa;
  } catch {
    sa = null;
  }
  return sa;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function accessToken(a: Sa): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.exp - 300 > now) return token.value;
  const header = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = createSign("RSA-SHA256").update(`${header}.${claim}`).sign(a.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${sig}` }),
  });
  if (!r.ok) throw new Error(`fcm token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

export function fcmConfigured(): boolean {
  return account() !== null;
}

/** The Firebase project the hub sends through (FCM_PROJECT_ID overrides the service account's). */
export function fcmProjectId(): string | null {
  return credential("FCM_PROJECT_ID") ?? account()?.project_id ?? null;
}

/** Sends the card to every token; returns tokens FCM says are gone (UNREGISTERED) so the caller can drop them. */
export async function sendFcm(tokens: string[], card: LocalizedCard): Promise<string[]> {
  const a = account();
  if (!a) return [];
  const at = await accessToken(a);
  const gone: string[] = [];
  const data: Record<string, string> = {
    type: card.dismissedAt ? "dismiss" : "card",
    id: card.id,
    kind: card.kind,
    tag: card.tag ?? "",
    title: card.title,
    body: card.body,
    subtitle: card.subtitle ?? "",
    color: card.color ?? "",
    icon: card.icon ?? "",
    image: card.image ?? "",
    priority: card.priority,
    progress: card.progress == null ? "" : String(card.progress),
    actions: JSON.stringify(card.actions),
    url: card.url ?? "",
    sticky: card.sticky ? "1" : "0",
    at: String(card.updatedAt.getTime()),
  };
  await Promise.all(
    tokens.map(async (t) => {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: t, data, android: { priority: card.priority === "low" ? "normal" : "high", ttl: "3600s" } } }),
      });
      if (r.status === 404 || r.status === 410) gone.push(t);
      else if (!r.ok) {
        const txt = await r.text();
        if (/UNREGISTERED|NOT_FOUND/.test(txt)) gone.push(t);
        else console.warn("[vmui] fcm send", r.status, txt.slice(0, 200));
      }
    }),
  );
  return gone;
}
