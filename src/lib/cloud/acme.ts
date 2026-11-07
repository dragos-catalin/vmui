import "server-only";

import { env } from "@/lib/env";
import * as acme from "acme-client";
import { X509Certificate } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import { patchCloudStatus } from "./status";

// Vatra Cloud certificate (docs/product/cloud/CONTRACT.md "ACME DNS-01 proxy"): the hub owns its ACME
// account and certificate key; the TXT record goes through the vatra-acme proxy, which only lets a hub
// write `_acme-challenge.<its own id>.<domain>`. Renewal follows ARI (RFC 9773), else 30 days before expiry.

const DAY = 86_400_000;
const ARI_RECHECK_MS = DAY;
const PROPAGATION_MS = 120_000;

export type CertState = { host: string; notAfter: number; notBefore: number; renewAt: number; ariCheckedAt: number | null; lastError: string | null; lastAttemptAt: number | null };

export function cloudDir(): string {
  return process.env.VATRA_CLOUD_DIR ?? join(dirname(resolve(env.VMUI_DB_PATH)), "cloud");
}
const file = (name: string) => join(cloudDir(), name);

function writeSecure(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: mode bits are advisory; the data dir ACL is what protects it there
  }
}

function readMaybe(name: string): string | null {
  const p = file(name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function readCertState(): CertState | null {
  const raw = readMaybe("state.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CertState;
  } catch {
    return null;
  }
}

function saveState(s: CertState): void {
  writeSecure(file("state.json"), JSON.stringify(s, null, 2));
  patchCloudStatus({ certNotAfter: s.notAfter || null, certRenewAt: s.renewAt || null, certError: s.lastError, host: s.host });
}

// ---------- ARI (RFC 9773) ----------

type Tlv = { tag: number; start: number; end: number; next: number };

function tlv(buf: Uint8Array, off: number): Tlv {
  const tag = buf[off] ?? 0;
  let len = buf[off + 1] ?? 0;
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("der_length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[start + i] ?? 0);
    start += n;
  }
  const end = start + len;
  if (end > buf.length) throw new Error("der_truncated");
  return { tag, start, end, next: end };
}

function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let off = parent.start; off < parent.end; ) {
    const t = tlv(buf, off);
    out.push(t);
    off = t.next;
  }
  return out;
}

const AKI_OID = Buffer.from([0x55, 0x1d, 0x23]);

/** keyIdentifier of the Authority Key Identifier extension, or null. */
export function authorityKeyId(der: Uint8Array): Buffer | null {
  const cert = tlv(der, 0);
  const tbs = children(der, cert)[0];
  if (!tbs) return null;
  const ext = children(der, tbs).find((c) => c.tag === 0xa3);
  if (!ext) return null;
  const list = children(der, ext)[0];
  if (!list) return null;
  for (const e of children(der, list)) {
    const parts = children(der, e);
    const oid = parts[0];
    if (!oid || oid.tag !== 0x06 || !Buffer.from(der.subarray(oid.start, oid.end)).equals(AKI_OID)) continue;
    const octets = parts.find((p) => p.tag === 0x04);
    if (!octets) return null;
    const seq = tlv(der, octets.start);
    const kid = children(der, seq).find((c) => c.tag === 0x80);
    return kid ? Buffer.from(der.subarray(kid.start, kid.end)) : null;
  }
  return null;
}

/** DER INTEGER content bytes of a serial given as hex (a leading 0x00 when the high bit is set). */
export function serialDerBytes(hex: string): Buffer {
  let h = hex.replace(/[^0-9a-f]/gi, "");
  if (h.length % 2) h = `0${h}`;
  let b = Buffer.from(h, "hex");
  while (b.length > 1 && b[0] === 0 && ((b[1] ?? 0) & 0x80) === 0) b = b.subarray(1);
  return (b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
}

export function encodeCertId(aki: Buffer, serialHex: string): string {
  return `${aki.toString("base64url")}.${serialDerBytes(serialHex).toString("base64url")}`;
}

/** RFC 9773 certID of a PEM certificate, null when it has no AKI. */
export function ariCertId(pem: string): string | null {
  const x = new X509Certificate(pem);
  const aki = authorityKeyId(x.raw);
  return aki ? encodeCertId(aki, x.serialNumber) : null;
}

/** A random instant inside the suggested window (never in the past). */
export function pickRenewAt(window: { start: string; end: string }, now = Date.now(), rand = Math.random): number | null {
  const s = Date.parse(window.start);
  const e = Date.parse(window.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  if (e <= now) return now;
  const from = Math.max(s, now);
  return Math.floor(from + (e - from) * rand());
}

/** 30 days before expiry, or the last third of a shorter certificate's life. */
export function fallbackRenewAt(notBefore: number, notAfter: number): number {
  return notAfter - Math.min(30 * DAY, Math.max(0, notAfter - notBefore) / 3);
}

function directoryUrl(): string {
  return process.env.VATRA_ACME_STAGING === "1" ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

async function ariRenewAt(pem: string): Promise<number | null> {
  const id = ariCertId(pem);
  if (!id) return null;
  const dir = (await (await fetch(directoryUrl(), { signal: AbortSignal.timeout(15_000) })).json()) as { renewalInfo?: string };
  if (!dir.renewalInfo) return null;
  const r = await fetch(`${dir.renewalInfo.replace(/\/$/, "")}/${id}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { suggestedWindow?: { start: string; end: string } };
  return j.suggestedWindow ? pickRenewAt(j.suggestedWindow) : null;
}

async function computeRenewAt(pem: string, notBefore: number, notAfter: number): Promise<{ renewAt: number; ari: boolean }> {
  try {
    const at = await ariRenewAt(pem);
    if (at !== null) return { renewAt: at, ari: true };
  } catch {
    // ARI is advisory: fall back to the fixed margin
  }
  return { renewAt: fallbackRenewAt(notBefore, notAfter), ari: false };
}

// ---------- keys + TLS context ----------

async function accountKey(): Promise<Buffer> {
  const have = readMaybe("account.key");
  if (have) return Buffer.from(have);
  const key = await acme.crypto.createPrivateEcdsaKey("P-256");
  writeSecure(file("account.key"), key);
  return key;
}

let ctx: { mtime: string; context: SecureContext } | null = null;

/** TLS context with the current certificate; rebuilt after a renewal. Null until one is issued. */
export function getTlsContext(): SecureContext | null {
  const key = readMaybe("key.pem");
  const chain = readMaybe("fullchain.pem");
  if (!key || !chain) return null;
  const stamp = readCertState()?.notAfter.toString() ?? chain.length.toString();
  if (ctx?.mtime === stamp) return ctx.context;
  ctx = { mtime: stamp, context: createSecureContext({ key, cert: chain }) };
  return ctx.context;
}

/** Valid certificate for `host` with at least `marginMs` left. */
export function hasUsableCert(host: string, marginMs = 0, now = Date.now()): boolean {
  const s = readCertState();
  return !!s && s.host === host && s.notAfter - marginMs > now && existsSync(file("fullchain.pem")) && existsSync(file("key.pem"));
}

// ---------- DNS-01 via the proxy ----------

async function proxyCall(path: "present" | "cleanup", fqdn: string, value: string): Promise<void> {
  const { cloudEndpoints, hubJwt } = await import("./identity");
  const r = await fetch(`${cloudEndpoints().acme}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${hubJwt("vatra-acme")}`, "content-type": "application/json" },
    body: JSON.stringify({ fqdn, value }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(`acme_${path}_${r.status}${j.error ? `_${j.error}` : ""}`);
  }
}

/** Poll 1.1.1.1 and 8.8.8.8 until both serve the TXT value (max 120 s). */
export async function waitForTxt(name: string, value: string, timeoutMs = PROPAGATION_MS, servers = ["1.1.1.1", "8.8.8.8"]): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(servers);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const server of [...pending]) {
      const r = new Resolver({ timeout: 4000, tries: 1 });
      r.setServers([server]);
      try {
        const txt = await r.resolveTxt(name);
        if (txt.some((parts) => parts.join("") === value)) pending.delete(server);
      } catch {
        // NXDOMAIN / timeout: keep polling
      }
    }
    if (pending.size > 0) await new Promise((res) => setTimeout(res, 5000));
  }
  return pending.size === 0;
}

let inflight: Promise<CertState> | null = null;

/** Order (or renew) the certificate for `host`. Concurrent calls share one order. */
export function issueCertificate(host: string): Promise<CertState> {
  inflight ??= doIssue(host).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doIssue(host: string): Promise<CertState> {
  const prev = readCertState();
  const attemptAt = Date.now();
  try {
    const client = new acme.Client({ directoryUrl: directoryUrl(), accountKey: await accountKey() });
    const certKey = await acme.crypto.createPrivateEcdsaKey("P-256");
    const [, csr] = await acme.crypto.createCsr({ commonName: host, altNames: [host] }, certKey);
    const fullchain = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ["dns-01"],
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
        const name = `_acme-challenge.${authz.identifier.value}`;
        await proxyCall("present", `${name}.`, keyAuthorization);
        await waitForTxt(name, keyAuthorization);
      },
      challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
        await proxyCall("cleanup", `_acme-challenge.${authz.identifier.value}.`, keyAuthorization);
      },
    });
    const parts = acme.crypto.splitPemChain(fullchain);
    const leaf = parts[0];
    if (!leaf) throw new Error("acme_empty_chain");
    const x = new X509Certificate(leaf);
    const notAfter = Date.parse(x.validTo);
    const notBefore = Date.parse(x.validFrom);
    writeSecure(file("key.pem"), certKey);
    writeSecure(file("cert.pem"), leaf);
    writeSecure(file("chain.pem"), parts.slice(1).join("\n"));
    writeSecure(file("fullchain.pem"), fullchain);
    const { renewAt, ari } = await computeRenewAt(leaf, notBefore, notAfter);
    const state: CertState = { host, notAfter, notBefore, renewAt, ariCheckedAt: ari ? Date.now() : null, lastError: null, lastAttemptAt: attemptAt };
    saveState(state);
    ctx = null;
    return state;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const state: CertState = prev ? { ...prev, lastError: msg, lastAttemptAt: attemptAt } : { host, notAfter: 0, notBefore: 0, renewAt: 0, ariCheckedAt: null, lastError: msg, lastAttemptAt: attemptAt };
    saveState(state);
    throw e;
  }
}

/** Re-ask ARI once a day: the CA may move the window (e.g. a revocation event). */
export async function refreshRenewAt(now = Date.now()): Promise<CertState | null> {
  const s = readCertState();
  const leaf = readMaybe("cert.pem");
  if (!s || !leaf || !s.notAfter) return s;
  if (s.ariCheckedAt && now - s.ariCheckedAt < ARI_RECHECK_MS) return s;
  const { renewAt, ari } = await computeRenewAt(leaf, s.notBefore, s.notAfter);
  const next = { ...s, renewAt, ariCheckedAt: ari ? now : s.ariCheckedAt };
  saveState(next);
  return next;
}

/** Push the stored certificate state into the live status (startup). */
export function publishCertStatus(): void {
  const s = readCertState();
  if (s) patchCloudStatus({ certNotAfter: s.notAfter || null, certRenewAt: s.renewAt || null, certError: s.lastError });
}
