import "server-only";

import { decryptJSON, encryptJSON } from "@/lib/crypto";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { credential } from "@/lib/home/credentials";
import { eq } from "drizzle-orm";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Vatra Cloud hub identity (docs/product/cloud/CONTRACT.md): one Ed25519 key per hub, encrypted with the
// master key in app_settings. The hub id is derived from the public key, so every cloud service can check
// a hub's claims without a registry and a hub cannot speak for another one.

const KEY = "cloud.identity";
export type CloudAudience = "vatra-push" | "vatra-acme" | "vatra-relay-token";

type Stored = { v: 1; pkcs8: string };
let cached: { priv: KeyObject; pub: Buffer; hubId: string } | null = null;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 16 chars [a-z2-7]: base32 of the first 10 bytes of sha256(raw public key). */
export function hubIdFor(rawPub: Buffer): string {
  return base32(createHash("sha256").update(rawPub).digest().subarray(0, 10));
}

function rawPublic(priv: KeyObject): Buffer {
  const der = createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

function load(): { priv: KeyObject; pub: Buffer; hubId: string } {
  if (cached) return cached;
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  let priv: KeyObject;
  if (row) {
    const s = decryptJSON<Stored>(row.value);
    priv = createPrivateKey({ key: Buffer.from(s.pkcs8, "base64"), format: "der", type: "pkcs8" });
  } else {
    priv = generateKeyPairSync("ed25519").privateKey;
    const value = encryptJSON({ v: 1, pkcs8: priv.export({ format: "der", type: "pkcs8" }).toString("base64") } satisfies Stored);
    db.insert(settings).values({ key: KEY, value, updatedAt: new Date() }).onConflictDoNothing().run();
    // a concurrent first call may have won the insert: re-read so every worker uses the same key
    const again = db.select().from(settings).where(eq(settings.key, KEY)).get();
    if (again && again.value !== value) priv = createPrivateKey({ key: Buffer.from(decryptJSON<Stored>(again.value).pkcs8, "base64"), format: "der", type: "pkcs8" });
  }
  const pub = rawPublic(priv);
  cached = { priv, pub, hubId: hubIdFor(pub) };
  return cached;
}

export function hubIdentity(): { hubId: string; pub: string } {
  const k = load();
  return { hubId: k.hubId, pub: k.pub.toString("base64url") };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Short-lived EdDSA JWT for one cloud audience (exp 300 s, unique jti). */
export function hubJwt(aud: CloudAudience, now = Math.floor(Date.now() / 1000)): string {
  const k = load();
  const head = b64({ alg: "EdDSA", typ: "JWT" });
  const claims = b64({ iss: k.hubId, aud, iat: now, exp: now + 300, jti: randomBytes(12).toString("base64url"), pub: k.pub.toString("base64url") });
  const sig = sign(null, Buffer.from(`${head}.${claims}`), k.priv).toString("base64url");
  return `${head}.${claims}.${sig}`;
}

export function cloudDomain(): string {
  return (credential("VATRA_CLOUD_DOMAIN") ?? "vatra.dragoscatalin.ro").toLowerCase().replace(/\.$/, "");
}

export function cloudEndpoints(): { api: string; acme: string; relay: string; relayPin: string | null; domain: string } {
  const domain = cloudDomain();
  return {
    domain,
    api: (credential("VATRA_CLOUD_API") ?? `https://push.${domain}`).replace(/\/$/, ""),
    acme: (credential("VATRA_CLOUD_ACME") ?? `https://acme.${domain}`).replace(/\/$/, ""),
    relay: credential("VATRA_CLOUD_RELAY") ?? `relay.${domain}:8443`,
    relayPin: credential("VATRA_CLOUD_RELAY_PIN") ?? null,
  };
}

/** The hub's public name under Vatra Cloud. */
export function cloudHostname(): string {
  return `${hubIdentity().hubId}.${cloudDomain()}`;
}

/** Test seam: forget the cached key (the db row stays). */
export function resetIdentityCache(): void {
  cached = null;
}
