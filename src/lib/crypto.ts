import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { previousMasterKeys, requireMasterKey } from "./env";

const ALGO = "aes-256-gcm";
const V1 = "v1.";

/** Short, non-secret fingerprint of a key: tells decrypt which key of the ring to use. */
export const keyId = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 8);

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${V1}${keyId(key)}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

function open(b64: string, key: Buffer): string {
  const buf = Buffer.from(b64, "base64");
  const decipher = createDecipheriv(ALGO, key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * AES-256-GCM with the current master key. Format `v1.<keyId>.<base64(iv | tag | ct)>`;
 * the key id lets a rotation keep old rows readable until they are re-encrypted.
 */
export function encrypt(plaintext: string): string {
  return seal(plaintext, requireMasterKey());
}

/** Accepts `v1.` payloads (key picked by id) and legacy untagged base64 (current key, then retired ones). */
export function decrypt(payload: string): string {
  const ring = [requireMasterKey(), ...previousMasterKeys()];
  if (payload.startsWith(V1)) {
    const dot = payload.indexOf(".", V1.length);
    const kid = payload.slice(V1.length, dot);
    const key = ring.find((k) => keyId(k) === kid);
    if (!key) throw new Error(`no master key with id ${kid} (restore vatra-master.key / vatra-master.prev)`);
    return open(payload.slice(dot + 1), key);
  }
  let last: unknown;
  for (const key of ring) {
    try {
      return open(payload, key);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("decrypt failed");
}

/** True when the payload is already sealed with the current key (rotation skips it). */
export const isCurrent = (payload: string): boolean => payload.startsWith(`${V1}${keyId(requireMasterKey())}.`);

export function encryptJSON(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJSON<T = unknown>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}
