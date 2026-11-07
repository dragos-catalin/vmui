// Test-only: self-signed certificates via @peculiar/x509 (an acme-client dependency, resolved through
// acme-client so the strict pnpm layout does not need it hoisted). Not imported by app code.
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

type X509Mod = {
  cryptoProvider: { set(c: unknown): void };
  X509CertificateGenerator: { createSelfSigned(o: Record<string, unknown>): Promise<{ toString(f: "pem"): string }> };
  AuthorityKeyIdentifierExtension: new (keyIdHex: string, critical?: boolean) => unknown;
  SubjectAlternativeNameExtension: new (names: Array<{ type: string; value: string }>, critical?: boolean) => unknown;
};

const req = createRequire(createRequire(import.meta.url).resolve("acme-client"));
const x509 = req("@peculiar/x509") as X509Mod;
x509.cryptoProvider.set(webcrypto);

export type TestCert = { cert: string; key: string };

export async function selfSigned(opts: { cn: string; serialHex?: string; akiHex?: string; dns?: string[]; ip?: string[] }): Promise<TestCert> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const extensions: unknown[] = [];
  if (opts.akiHex) extensions.push(new x509.AuthorityKeyIdentifierExtension(opts.akiHex));
  const names = [...(opts.dns ?? []).map((value) => ({ type: "dns", value })), ...(opts.ip ?? []).map((value) => ({ type: "ip", value }))];
  if (names.length) extensions.push(new x509.SubjectAlternativeNameExtension(names));
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: opts.serialHex ?? "01",
    name: `CN=${opts.cn}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: alg,
    keys,
    extensions,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const key = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END PRIVATE KEY-----\n`;
  return { cert: cert.toString("pem"), key };
}
