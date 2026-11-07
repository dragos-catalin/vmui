import { describe, expect, it } from "vitest";
import { ariCertId, authorityKeyId, encodeCertId, fallbackRenewAt, pickRenewAt, serialDerBytes } from "./acme";
import { selfSigned } from "./test-certs";

// RFC 9773 §4.1 example: AKI 69:88:5B:6B:87:46:40:41:E1:B3:7B:84:7B:A0:AE:2C:DE:01:C8:D4, serial 0x87654321.
const RFC_AKI = "69885b6b87464041e1b37b847ba0ae2cde01c8d4";
const RFC_CERT_ID = "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE";
const DAY = 86_400_000;

describe("ARI certID (RFC 9773)", () => {
  it("encodes the RFC example vector", () => {
    expect(encodeCertId(Buffer.from(RFC_AKI, "hex"), "87654321")).toBe(RFC_CERT_ID);
  });

  it("keeps DER integer form for the serial: leading zero only when the high bit is set", () => {
    expect(serialDerBytes("87654321").toString("hex")).toBe("0087654321");
    expect(serialDerBytes("0087654321").toString("hex")).toBe("0087654321");
    expect(serialDerBytes("0012").toString("hex")).toBe("12");
    expect(serialDerBytes("7f").toString("hex")).toBe("7f");
  });

  it("reads AKI + serial from a real certificate", async () => {
    const { cert } = await selfSigned({ cn: "ari.test", serialHex: "0087654321", akiHex: RFC_AKI });
    const der = new (await import("node:crypto")).X509Certificate(cert).raw;
    expect(authorityKeyId(der)?.toString("hex")).toBe(RFC_AKI);
    expect(ariCertId(cert)).toBe(RFC_CERT_ID);
  });

  it("returns null for a certificate without AKI", async () => {
    const { cert } = await selfSigned({ cn: "no-aki.test" });
    expect(ariCertId(cert)).toBeNull();
  });
});

describe("renewal time", () => {
  it("picks a point inside the suggested window", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const w = { start: "2026-12-01T00:00:00Z", end: "2026-12-03T00:00:00Z" };
    expect(pickRenewAt(w, now, () => 0)).toBe(Date.parse(w.start));
    expect(pickRenewAt(w, now, () => 0.5)).toBe(Date.parse("2026-12-02T00:00:00Z"));
    expect(pickRenewAt(w, now, () => 0.999999)).toBeLessThanOrEqual(Date.parse(w.end));
  });

  it("never schedules in the past and rejects malformed windows", () => {
    const now = Date.parse("2026-12-05T00:00:00Z");
    expect(pickRenewAt({ start: "2026-12-01T00:00:00Z", end: "2026-12-03T00:00:00Z" }, now)).toBe(now);
    expect(pickRenewAt({ start: "2026-12-04T00:00:00Z", end: "2026-12-06T00:00:00Z" }, now, () => 0)).toBe(now);
    expect(pickRenewAt({ start: "x", end: "y" }, now)).toBeNull();
    expect(pickRenewAt({ start: "2026-12-06T00:00:00Z", end: "2026-12-04T00:00:00Z" }, now)).toBeNull();
  });

  it("falls back to 30 days before expiry (a third of the life for short certificates)", () => {
    const nb = Date.parse("2026-11-01T00:00:00Z");
    expect(fallbackRenewAt(nb, nb + 90 * DAY)).toBe(nb + 60 * DAY);
    expect(fallbackRenewAt(nb, nb + 6 * DAY)).toBe(nb + 4 * DAY);
  });
});
