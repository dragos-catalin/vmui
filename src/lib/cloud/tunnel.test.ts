import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cloudStatus, resetCloudStatus } from "./status";
import { selfSigned, type TestCert } from "./test-certs";
import { forwardHeaders, parseProxyV2, pinMatches, PROXY_V2_SIG, ProxyHeaderError, spkiPin, splitHostPort, startTunnel, type TunnelHandle } from "./tunnel";

function v2(cmd: number, fam: number, body: Buffer): Buffer {
  const h = Buffer.alloc(16);
  PROXY_V2_SIG.copy(h, 0);
  h[12] = 0x20 | cmd;
  h[13] = fam;
  h.writeUInt16BE(body.length, 14);
  return Buffer.concat([h, body]);
}
function tcp4(src: string, dst: string, sport: number, dport: number): Buffer {
  const b = Buffer.alloc(12);
  src.split(".").forEach((o, i) => (b[i] = Number(o)));
  dst.split(".").forEach((o, i) => (b[4 + i] = Number(o)));
  b.writeUInt16BE(sport, 8);
  b.writeUInt16BE(dport, 10);
  return v2(1, 0x11, b);
}

describe("PROXY v2 parser", () => {
  it("parses TCP4 and leaves the payload after the header", () => {
    const buf = Buffer.concat([tcp4("203.0.113.7", "10.0.0.1", 51000, 443), Buffer.from("\x16\x03\x01hello")]);
    const r = parseProxyV2(buf);
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.header).toEqual({ command: "proxy", family: "tcp4", srcAddr: "203.0.113.7", dstAddr: "10.0.0.1", srcPort: 51000, dstPort: 443 });
    expect(buf.subarray(r.consumed).toString("latin1")).toBe("\x16\x03\x01hello");
  });

  it("parses TCP6 with zero compression", () => {
    const body = Buffer.alloc(36);
    Buffer.from("20010db8000000000000000000000001", "hex").copy(body, 0);
    Buffer.from("fe800000000000000000000000000002", "hex").copy(body, 16);
    body.writeUInt16BE(1234, 32);
    body.writeUInt16BE(443, 34);
    const r = parseProxyV2(v2(1, 0x21, body));
    expect(r.done && r.header).toMatchObject({ family: "tcp6", srcAddr: "2001:db8::1", dstAddr: "fe80::2", srcPort: 1234, dstPort: 443 });
  });

  it("accepts LOCAL (health checks) with no address", () => {
    const r = parseProxyV2(v2(0, 0x00, Buffer.alloc(0)));
    expect(r.done && r.header).toEqual({ command: "local", family: "unspec", srcAddr: null, srcPort: null, dstAddr: null, dstPort: null });
  });

  it("asks for more bytes on a partial header", () => {
    const full = tcp4("1.2.3.4", "5.6.7.8", 1, 2);
    expect(parseProxyV2(full.subarray(0, 5))).toEqual({ done: false });
    expect(parseProxyV2(full.subarray(0, 20))).toEqual({ done: false });
  });

  it("rejects garbage, v1 text headers and bad versions", () => {
    expect(() => parseProxyV2(Buffer.from("GET / HTTP/1.1\r\n"))).toThrow(ProxyHeaderError);
    expect(() => parseProxyV2(Buffer.from("PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n"))).toThrow(ProxyHeaderError);
    const bad = tcp4("1.2.3.4", "5.6.7.8", 1, 2);
    bad[12] = 0x11;
    expect(() => parseProxyV2(bad)).toThrow("proxy_bad_version");
    expect(() => parseProxyV2(v2(1, 0x11, Buffer.alloc(4)))).toThrow("proxy_short_tcp4");
  });
});

describe("helpers", () => {
  it("splits host:port incl. IPv6", () => {
    expect(splitHostPort("relay.example:8443")).toEqual({ host: "relay.example", port: 8443 });
    expect(splitHostPort("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
  });

  it("overwrites client-sent forwarding headers and marks the request remote", () => {
    const h = forwardHeaders({ host: "h.example", "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6", "x-vatra-remote": "0", connection: "keep-alive" }, "203.0.113.7", false);
    expect(h["x-forwarded-for"]).toBe("203.0.113.7");
    expect(h["x-real-ip"]).toBe("203.0.113.7");
    expect(h["x-forwarded-proto"]).toBe("https");
    expect(h["x-vatra-remote"]).toBe("1");
    expect(h.host).toBe("h.example");
    expect(h.connection).toBeUndefined();
  });
});

// ---------- integration: fake relay + fake local hub ----------

const HUB_HOST = "abcdefghijklmnop.vatra.test";
let relayCert: TestCert;
let otherCert: TestCert;
let hubCert: TestCert;

beforeAll(async () => {
  [relayCert, otherCert, hubCert] = await Promise.all([selfSigned({ cn: "relay", ip: ["127.0.0.1"] }), selfSigned({ cn: "impostor" }), selfSigned({ cn: HUB_HOST, dns: [HUB_HOST] })]);
});

describe("pin check", () => {
  it("accepts only the matching SPKI", () => {
    const der = new X509Certificate(relayCert.cert).raw;
    const pin = spkiPin(der);
    expect(pinMatches(der, pin)).toBe(true);
    expect(pinMatches(der, spkiPin(new X509Certificate(otherCert.cert).raw))).toBe(false);
    expect(pinMatches(der, null)).toBe(false);
    expect(pinMatches(undefined, pin)).toBe(false);
  });
});

type FakeRelay = { port: number; publicPort: number; hellos: string[]; close: () => Promise<void> };

/** Minimal vatra-relay: control + data on one TLS port, public clients on a plain TCP port. */
async function fakeRelay(): Promise<FakeRelay> {
  const hellos: string[] = [];
  let control: tls.TLSSocket | null = null;
  const waiting = new Map<string, net.Socket>();
  let n = 0;
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
  };

  const server = tls.createServer({ key: relayCert.key, cert: relayCert.cert }, (s) => {
    track(s);
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      s.off("data", onData);
      const msg = JSON.parse(buf.subarray(0, nl).toString()) as { t: string; token?: string; id?: string };
      const rest = buf.subarray(nl + 1);
      if (msg.t === "hello") {
        hellos.push(msg.token ?? "");
        control = s;
        s.write(`${JSON.stringify({ t: "ok", hub: "abcdefghijklmnop", exp: 0 })}\n`);
        return;
      }
      if (msg.t === "data" && msg.id) {
        const client = waiting.get(msg.id);
        if (!client) return void s.destroy();
        waiting.delete(msg.id);
        if (rest.length) client.write(rest);
        s.write(tcp4("203.0.113.7", "10.0.0.1", 51000, 443));
        client.pipe(s).pipe(client);
        client.resume();
      }
    };
    s.on("data", onData);
  });
  const pub = net.createServer({ pauseOnConnect: true }, (client) => {
    track(client);
    const id = (++n).toString(16).padStart(24, "0");
    waiting.set(id, client);
    control?.write(`${JSON.stringify({ t: "dial", id })}\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => pub.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    publicPort: (pub.address() as AddressInfo).port,
    hellos,
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => pub.close(r))]);
    },
  };
}

async function fakeHub(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ xff: req.headers["x-forwarded-for"], proto: req.headers["x-forwarded-proto"], host: req.headers.host, remote: req.headers["x-vatra-remote"], path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("tunnel through a fake relay", () => {
  let cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanup.reverse()) await c();
    cleanup = [];
    resetCloudStatus();
  });

  const start = (relay: FakeRelay, hubPort: number, pin: string | null): TunnelHandle => {
    const t = startTunnel({
      fetchToken: async () => ({ token: "rt1.test.sig", exp: Math.floor(Date.now() / 1000) + 86_400, relay: `127.0.0.1:${relay.port}`, pin, host: HUB_HOST }),
      configuredPin: () => null,
      secureContext: () => tls.createSecureContext({ key: hubCert.key, cert: hubCert.cert }),
      localHost: "127.0.0.1",
      localPort: hubPort,
      now: Date.now,
    });
    cleanup.push(() => t.stop());
    return t;
  };

  it("serves a remote HTTPS client with x-forwarded-for from the PROXY header (client value ignored)", async () => {
    const relay = await fakeRelay();
    const hub = await fakeHub();
    cleanup.push(relay.close, hub.close);
    start(relay, hub.port, spkiPin(new X509Certificate(relayCert.cert).raw));
    await until(() => cloudStatus().state === "online");
    expect(relay.hellos).toEqual(["rt1.test.sig"]);

    const body = await new Promise<{ status: number; json: Record<string, string> }>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port: relay.publicPort, servername: HUB_HOST, ca: hubCert.cert, path: "/api/ping?x=1", headers: { host: HUB_HOST, "x-forwarded-for": "6.6.6.6" }, agent: false },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as Record<string, string> }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body.status).toBe(200);
    expect(body.json).toEqual({ xff: "203.0.113.7", proto: "https", host: HUB_HOST, remote: "1", path: "/api/ping?x=1" });
  });

  it("refuses a relay whose SPKI does not match the pin and never sends the token", async () => {
    const relay = await fakeRelay();
    const hub = await fakeHub();
    cleanup.push(relay.close, hub.close);
    start(relay, hub.port, spkiPin(new X509Certificate(otherCert.cert).raw));
    await until(() => cloudStatus().state === "error");
    expect(cloudStatus().lastError).toBe("relay_pin_mismatch");
    expect(relay.hellos).toEqual([]);
  });

  it("does not connect without any pin", async () => {
    const relay = await fakeRelay();
    const hub = await fakeHub();
    cleanup.push(relay.close, hub.close);
    start(relay, hub.port, null);
    await until(() => cloudStatus().state === "error");
    expect(cloudStatus().lastError).toBe("relay_pin_missing");
    expect(relay.hellos).toEqual([]);
  });
});
