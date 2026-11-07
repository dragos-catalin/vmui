import { credential } from "@/lib/home/credentials";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import "server-only";
import type { LocalizedCard } from "./index";
import { upPayload } from "./unifiedpush";

// Apple Push (P8-02) for the Vatra iPhone / iPad / watch app, direct: the hub holds an APNs auth key (.p8)
// of the team that signs the app — APNS_KEY (PEM text or a file path), APNS_KEY_ID, APNS_TEAM_ID,
// APNS_TOPIC (bundle id, default ro.vatra.app). Hubs without an Apple account use the Vatra Cloud relay
// instead (./relay.ts, end-to-end sealed; the app registers push kind "relay").
// The alert is visible (iOS has no reliable data-only wake), mutable-content lets the Notification Service
// Extension fetch the full card and attach the action buttons; `vatra` carries the same string fields as
// the FCM data map and the UnifiedPush JSON, so every app parses one shape (VatraCore PushPayload).

export type ApnsTarget = { token: string; sandbox: boolean; activityToken?: string | null };
export type ApnsRequest = { token: string; sandbox: boolean; headers: Record<string, string>; payload: Record<string, unknown> };
export type ApnsResult = { status: number; reason?: string };
export type ApnsSend = (r: ApnsRequest) => Promise<ApnsResult>;

const PROD = "https://api.push.apple.com";
const SANDBOX = "https://api.sandbox.push.apple.com";

type Direct = { key: KeyObject; keyId: string; teamId: string };

function topic(): string {
  return credential("APNS_TOPIC") ?? "ro.vatra.app";
}

let direct: Direct | null | undefined;
function directKey(): Direct | null {
  if (direct !== undefined) return direct;
  const raw = credential("APNS_KEY");
  const keyId = credential("APNS_KEY_ID");
  const teamId = credential("APNS_TEAM_ID");
  direct = null;
  if (!raw || !keyId || !teamId) return null;
  try {
    const pem = raw.includes("BEGIN PRIVATE KEY") ? raw.replace(/\\n/g, "\n") : readFileSync(raw, "utf8");
    direct = { key: createPrivateKey(pem), keyId, teamId };
  } catch (e) {
    console.warn("[vmui] apns key unreadable", (e as Error).message);
  }
  return direct;
}

export function apnsConfigured(): boolean {
  return directKey() !== null;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
let jwt: { value: string; at: number } | null = null;

/** Provider token: ES256 over {iss: team, iat}; Apple accepts it for up to 60 min, we renew at 50. */
export function providerToken(d: Direct, now = Math.floor(Date.now() / 1000)): string {
  if (jwt && now - jwt.at < 50 * 60) return jwt.value;
  const head = b64({ alg: "ES256", kid: d.keyId });
  const claim = b64({ iss: d.teamId, iat: now });
  const sig = createSign("SHA256").update(`${head}.${claim}`).sign({ key: d.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  jwt = { value: `${head}.${claim}.${sig}`, at: now };
  return jwt.value;
}

const LEVEL: Record<string, string> = { urgent: "time-sensitive", high: "time-sensitive", default: "active", low: "passive" };

/** The alert push for one card, or a silent background push telling the app to remove it. */
export function apnsRequests(card: LocalizedCard, t: ApnsTarget, bundle = topic()): ApnsRequest[] {
  const vatra = JSON.parse(upPayload(card)) as Record<string, string>;
  const collapse = (card.tag ?? card.id).slice(0, 64);
  if (card.dismissedAt) {
    return [{ token: t.token, sandbox: t.sandbox, headers: { "apns-push-type": "background", "apns-priority": "5", "apns-topic": bundle, "apns-collapse-id": collapse }, payload: { aps: { "content-available": 1 }, vatra } }];
  }
  const urgent = card.priority === "high" || card.priority === "urgent";
  const aps: Record<string, unknown> = {
    alert: { title: card.title, ...(card.subtitle ? { subtitle: card.subtitle } : {}), body: card.body || " " },
    "mutable-content": 1,
    category: `vatra.${card.kind}`,
    "thread-id": card.tag ?? card.kind,
    "interruption-level": LEVEL[card.priority] ?? "active",
    sound: urgent ? "default" : undefined,
  };
  const out: ApnsRequest[] = [
    {
      token: t.token,
      sandbox: t.sandbox,
      headers: { "apns-push-type": "alert", "apns-priority": card.priority === "low" ? "5" : "10", "apns-topic": bundle, "apns-collapse-id": collapse, "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600) },
      payload: { aps: JSON.parse(JSON.stringify(aps)) as Record<string, unknown>, vatra },
    },
  ];
  // Intercom ring: also start the Live Activity on the Lock Screen / Dynamic Island (iOS 17.2 push-to-start).
  if (card.kind === "intercom" && urgent && t.activityToken) {
    const now = Math.floor(Date.now() / 1000);
    out.push({
      token: t.activityToken,
      sandbox: t.sandbox,
      headers: { "apns-push-type": "liveactivity", "apns-priority": "10", "apns-topic": `${bundle}.push-type.liveactivity` },
      payload: {
        aps: {
          timestamp: now,
          event: "start",
          "attributes-type": "IntercomAttributes",
          attributes: { cardId: card.id, door: card.subtitle ?? "" },
          "content-state": { ringing: true, since: Math.floor(card.updatedAt.getTime() / 1000), canOpen: card.actions.some((a) => a.id === "open") },
          "stale-date": now + 120,
          "dismissal-date": now + 300,
          alert: { title: card.title, body: card.body || " " },
        },
      },
    });
  }
  return out;
}

let sessions: Map<string, http2.ClientHttp2Session> | undefined;
function session(origin: string): http2.ClientHttp2Session {
  sessions ??= new Map();
  const cur = sessions.get(origin);
  if (cur && !cur.closed && !cur.destroyed) return cur;
  const s = http2.connect(origin);
  s.on("error", () => sessions?.delete(origin));
  s.on("close", () => sessions?.delete(origin));
  s.setTimeout(60_000, () => s.close());
  sessions.set(origin, s);
  return s;
}

/** Straight to Apple over HTTP/2 with the hub's own key. */
function directSend(d: Direct): ApnsSend {
  return (r) =>
    new Promise((resolve) => {
      const s = session(r.sandbox ? SANDBOX : PROD);
      const req = s.request({ ":method": "POST", ":path": `/3/device/${r.token}`, authorization: `bearer ${providerToken(d)}`, "content-type": "application/json", ...r.headers });
      let status = 0;
      let body = "";
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => resolve({ status, reason: body ? ((JSON.parse(body) as { reason?: string }).reason ?? undefined) : undefined }));
      req.on("error", (e) => resolve({ status: 0, reason: e.message }));
      req.end(JSON.stringify(r.payload));
    });
}

function defaultSend(): ApnsSend | null {
  const d = directKey();
  return d ? directSend(d) : null;
}

const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** Sends the card to every device; returns the device tokens Apple says are gone so the caller drops them. */
export async function sendApns(targets: ApnsTarget[], card: LocalizedCard, send: ApnsSend | null = defaultSend()): Promise<string[]> {
  if (!send) return [];
  const gone: string[] = [];
  await Promise.all(
    targets.map(async (t) => {
      if (!/^[0-9a-f]{64,200}$/i.test(t.token)) return;
      for (const r of apnsRequests(card, t)) {
        const res = await send(r);
        if (res.status === 200) continue;
        // a dead Live Activity token only loses the activity, never the device's notifications
        if (r.token === t.token && (res.status === 410 || GONE.has(res.reason ?? ""))) gone.push(t.token);
        else console.warn("[vmui] apns send", res.status, res.reason ?? "", r.headers["apns-push-type"]);
      }
    }),
  );
  return gone;
}
