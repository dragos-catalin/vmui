import "server-only";
import webpush from "web-push";
import type { LocalizedCard } from "./index";

// UnifiedPush (P7-03): the de-Googled flavour of the Android app registers a Web Push endpoint
// with its distributor (ntfy, NextPush, …) and hands it to PUT /api/v1/app/push together with
// its P-256 key and auth secret. We encrypt the card (RFC 8291, aes128gcm) so the distributor
// only ever sees ciphertext. VAPID is optional for UnifiedPush; when the hub has keys we sign.

export type UpTarget = { endpoint: string; p256dh: string; auth: string };

/** Web Push carries at most ~4 KB of ciphertext: keep the payload well under it. */
const MAX_PAYLOAD = 3000;

/** The same data-only shape the FCM path sends, so the app has one renderer. */
export function upPayload(card: LocalizedCard): string {
  const base = {
    type: card.dismissedAt ? "dismiss" : "card",
    id: card.id,
    kind: card.kind,
    tag: card.tag ?? "",
    title: card.title,
    body: card.body,
    subtitle: card.subtitle ?? "",
    color: card.color ?? "",
    icon: card.icon ?? "",
    priority: card.priority,
    progress: card.progress == null ? "" : String(card.progress),
    actions: JSON.stringify(card.actions.map((a) => ({ id: a.id, label: a.label, style: a.style, ...(a.url ? { url: a.url } : {}) }))),
    url: card.url ?? "",
    sticky: card.sticky ? "1" : "0",
    at: String(card.updatedAt.getTime()),
  };
  let out = JSON.stringify(base);
  if (out.length > MAX_PAYLOAD) out = JSON.stringify({ ...base, body: base.body.slice(0, 400), actions: "[]", image: "" });
  if (out.length > MAX_PAYLOAD) out = JSON.stringify({ type: base.type, id: base.id, kind: base.kind, tag: base.tag, title: base.title.slice(0, 200), priority: base.priority, at: base.at, fetch: "1" });
  return out;
}

/** Only https endpoints on a public-looking host: a stored endpoint must never make the hub POST into its own LAN. */
export function endpointAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;
  if (/^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h.startsWith("[") || h.includes(":")) return false;
  return true;
}

function vapid(): { subject: string; publicKey: string; privateKey: string } | undefined {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  return pub && priv ? { subject: process.env.VAPID_SUBJECT ?? "mailto:vatra@localhost", publicKey: pub, privateKey: priv } : undefined;
}

/** Sends the card to every endpoint; returns the endpoints the push service says are gone (404/410). */
export async function sendUnifiedPush(targets: UpTarget[], card: LocalizedCard, send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush)): Promise<string[]> {
  const payload = upPayload(card);
  const gone: string[] = [];
  const urgency = card.priority === "urgent" || card.priority === "high" ? "high" : card.priority === "low" ? "low" : "normal";
  await Promise.all(
    targets.map(async (t) => {
      if (!endpointAllowed(t.endpoint)) return;
      try {
        await send({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, payload, { TTL: 3600, urgency, vapidDetails: vapid(), timeout: 10_000 });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(t.endpoint);
        else console.warn("[vmui] unifiedpush send", code ?? (e as Error).message);
      }
    }),
  );
  return gone;
}
