import { createECDH, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import webpush from "web-push";
import { describe, expect, it } from "vitest";
import { endpointAllowed, sendUnifiedPush, upPayload } from "./unifiedpush";
import type { LocalizedCard } from "./index";

const card = (over: Partial<LocalizedCard> = {}): LocalizedCard =>
  ({
    id: "c1",
    kind: "intercom",
    tag: "door",
    title: "Sună la ușă",
    body: "Interfon",
    subtitle: null,
    color: "#ff8800",
    icon: "door",
    image: null,
    priority: "high",
    progress: null,
    actions: [{ id: "open", label: "Deschide", style: "primary", body: { secret: "x" } }],
    url: null,
    sticky: false,
    dismissedAt: null,
    updatedAt: new Date(1_700_000_000_000),
    ...over,
  }) as unknown as LocalizedCard;

// RFC 8291 receiver side, to prove the distributor only ever carries ciphertext the app can open.
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

describe("UnifiedPush delivery", () => {
  it("encrypts the card so only the device can read it, without the action callback bodies", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: "https://ntfy.sh/upX", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
    const details = webpush.generateRequestDetails(sub, upPayload(card()), { TTL: 60 });
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.body.toString("latin1")).not.toContain("Sună");
    const data = JSON.parse(decrypt(details.body, ua, auth)) as Record<string, string>;
    expect(data).toMatchObject({ type: "card", id: "c1", kind: "intercom", title: "Sună la ușă", priority: "high" });
    expect(data.actions).not.toContain("secret");
  });

  it("keeps an oversized card under the Web Push limit", () => {
    const big = upPayload(card({ title: "t".repeat(5000), body: "b".repeat(5000) }));
    expect(big.length).toBeLessThanOrEqual(3000);
    expect(JSON.parse(big)).toMatchObject({ id: "c1", fetch: "1" });
  });

  it("refuses endpoints on the LAN or without TLS", () => {
    expect(endpointAllowed("https://ntfy.sh/up")).toBe(true);
    for (const u of ["http://ntfy.sh/up", "https://127.0.0.1/up", "https://172.20.0.1/up", "https://nas.lan/up", "https://[::1]/up", "https://u:p@ntfy.sh/up", "nope"]) expect(endpointAllowed(u), u).toBe(false);
  });

  it("reports gone endpoints and maps priority to urgency", async () => {
    const seen: Array<{ endpoint: string; urgency: unknown }> = [];
    const send = (async (s: { endpoint: string }, _p: unknown, o: { urgency?: unknown }) => {
      seen.push({ endpoint: s.endpoint, urgency: o.urgency });
      if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return { statusCode: 201 };
    }) as unknown as typeof webpush.sendNotification;
    const k = { p256dh: "x", auth: "y" };
    const gone = await sendUnifiedPush([{ endpoint: "https://a.example/ok", ...k }, { endpoint: "https://a.example/gone", ...k }, { endpoint: "https://10.0.0.1/lan", ...k }], card(), send);
    expect(gone).toEqual(["https://a.example/gone"]);
    expect(seen.map((s) => s.endpoint)).toEqual(["https://a.example/ok", "https://a.example/gone"]);
    expect(seen[0]?.urgency).toBe("high");
  });
});
