import "server-only";

import { timingSafeEqual, createHash, X509Certificate } from "node:crypto";
import http from "node:http";
import { isIP, type Socket } from "node:net";
import { Duplex } from "node:stream";
import tls, { type SecureContext, type TLSSocket } from "node:tls";
import { clientDelta, patchCloudStatus, setTunnelState } from "./status";

// Hub side of the Vatra Cloud SNI relay (docs/product/cloud/CONTRACT.md "SNI relay"). The relay never
// sees plaintext: it forwards the client's TLS bytes, prefixed by a PROXY v2 header, over a data
// connection this hub opens on request; TLS terminates here with the hub's own ACME certificate and the
// HTTP inside is proxied to the local hub with x-forwarded-for overwritten by the PROXY client address.

export type RelayToken = { token: string; exp: number; relay: string; pin: string | null; host: string };

export type TunnelDeps = {
  fetchToken: () => Promise<RelayToken>;
  /** Pin configured by the operator; wins over the one in the token response. */
  configuredPin: () => string | null;
  secureContext: () => SecureContext | null;
  localPort: number;
  localHost: string;
  now: () => number;
};

export type TunnelHandle = { stop: () => void; refresh: () => void };

const PING_SILENCE_MS = 75_000;
const REFRESH_BEFORE_S = 3600;
const MAX_LINE = 16 * 1024;
const MAX_PROXY_HEADER = 16 + 216; // largest v2 address block (AF_UNIX) + slack for TLVs is capped below
const DATA_HEADER_TIMEOUT_MS = 10_000;

// ---------- PROXY protocol v2 ----------

export const PROXY_V2_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

export type ProxyHeader = { command: "local" | "proxy"; family: "tcp4" | "tcp6" | "unspec"; srcAddr: string | null; srcPort: number | null; dstAddr: string | null; dstPort: number | null };
export type ProxyParse = { done: false } | { done: true; header: ProxyHeader; consumed: number };

export class ProxyHeaderError extends Error {}

function ipv6(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  // compress the longest zero run
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

/** Parse a PROXY v2 header at the start of `buf`. Needs more bytes → {done:false}; not v2 → throws. */
export function parseProxyV2(buf: Buffer): ProxyParse {
  const sigLen = Math.min(buf.length, 12);
  if (!buf.subarray(0, sigLen).equals(PROXY_V2_SIG.subarray(0, sigLen))) throw new ProxyHeaderError("proxy_bad_signature");
  if (buf.length < 16) return { done: false };
  const verCmd = buf[12] ?? 0;
  if (verCmd >> 4 !== 2) throw new ProxyHeaderError("proxy_bad_version");
  const cmd = verCmd & 0x0f;
  if (cmd > 1) throw new ProxyHeaderError("proxy_bad_command");
  const fam = buf[13] ?? 0;
  const len = buf.readUInt16BE(14);
  if (len > MAX_PROXY_HEADER) throw new ProxyHeaderError("proxy_too_long");
  if (buf.length < 16 + len) return { done: false };
  const body = buf.subarray(16, 16 + len);
  const consumed = 16 + len;
  const blank = { srcAddr: null, srcPort: null, dstAddr: null, dstPort: null };
  if (cmd === 0) return { done: true, consumed, header: { command: "local", family: "unspec", ...blank } };
  if (fam === 0x11) {
    if (len < 12) throw new ProxyHeaderError("proxy_short_tcp4");
    return {
      done: true,
      consumed,
      header: { command: "proxy", family: "tcp4", srcAddr: [...body.subarray(0, 4)].join("."), dstAddr: [...body.subarray(4, 8)].join("."), srcPort: body.readUInt16BE(8), dstPort: body.readUInt16BE(10) },
    };
  }
  if (fam === 0x21) {
    if (len < 36) throw new ProxyHeaderError("proxy_short_tcp6");
    return {
      done: true,
      consumed,
      header: { command: "proxy", family: "tcp6", srcAddr: ipv6(body.subarray(0, 16)), dstAddr: ipv6(body.subarray(16, 32)), srcPort: body.readUInt16BE(32), dstPort: body.readUInt16BE(34) },
    };
  }
  if (fam === 0x00) return { done: true, consumed, header: { command: "proxy", family: "unspec", ...blank } };
  throw new ProxyHeaderError("proxy_unsupported_family");
}

// ---------- relay pin ----------

/** base64url sha256 of the certificate's SubjectPublicKeyInfo (DER). */
export function spkiPin(certDer: Buffer): string {
  const spki = new X509Certificate(certDer).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url");
}

export function pinMatches(certDer: Buffer | undefined, want: string | null): boolean {
  if (!certDer || !want) return false;
  const got = Buffer.from(spkiPin(certDer));
  const exp = Buffer.from(want.replace(/=+$/, ""));
  return got.length === exp.length && timingSafeEqual(got, exp);
}

export function splitHostPort(hp: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(hp) ?? /^([^:]+):(\d+)$/.exec(hp);
  if (!m?.[1] || !m[2]) return { host: hp, port: 8443 };
  return { host: m[1], port: Number(m[2]) };
}

/** TLS to the relay, resolved only once the SPKI pin matched; nothing is written before that. */
function connectPinned(relay: string, pin: string | null): Promise<TLSSocket> {
  const { host, port } = splitHostPort(relay);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false });
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.once("error", fail);
    sock.setTimeout(15_000, () => fail(new Error("relay_timeout")));
    sock.once("secureConnect", () => {
      sock.setTimeout(0);
      sock.off("error", fail);
      if (!pinMatches(sock.getPeerCertificate(true)?.raw, pin)) return fail(new Error("relay_pin_mismatch"));
      resolve(sock);
    });
  });
}

// ---------- local HTTP proxy ----------

const clientIp = new WeakMap<object, string>();
const HOP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

/** Headers sent to the local hub: the relay-reported client address replaces anything the client sent. */
export function forwardHeaders(incoming: http.IncomingHttpHeaders, ip: string, upgrade: boolean): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (!upgrade && HOP.includes(k)) continue;
    out[k] = v;
  }
  out["x-forwarded-for"] = ip;
  out["x-real-ip"] = ip;
  out["x-forwarded-proto"] = "https";
  if (incoming.host) out["x-forwarded-host"] = incoming.host;
  out["x-vatra-remote"] = "1";
  return out;
}

function rawHead(status: number, message: string, rawHeaders: string[]): string {
  let s = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) s += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  return `${s}\r\n`;
}

function localProxy(deps: Pick<TunnelDeps, "localHost" | "localPort">): http.Server {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const server = http.createServer((req, res) => {
    const ip = clientIp.get(req.socket) ?? "0.0.0.0";
    const up = http.request({ host: deps.localHost, port: deps.localPort, method: req.method, path: req.url, headers: forwardHeaders(req.headers, ip, false), agent }, (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, ures.headers);
      res.flushHeaders();
      ures.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const ip = clientIp.get(req.socket) ?? "0.0.0.0";
    const up = http.request({ host: deps.localHost, port: deps.localPort, method: req.method, path: req.url, headers: forwardHeaders(req.headers, ip, true) });
    up.on("upgrade", (ures, usock, uhead) => {
      socket.write(rawHead(ures.statusCode ?? 101, ures.statusMessage ?? "Switching Protocols", ures.rawHeaders));
      if (uhead.length) socket.write(uhead);
      if (head.length) usock.write(head);
      usock.pipe(socket).pipe(usock);
      usock.on("error", () => socket.destroy());
      socket.on("error", () => usock.destroy());
      socket.on("close", () => usock.destroy());
      usock.on("close", () => socket.destroy());
    });
    up.on("response", (ures) => {
      socket.write(rawHead(ures.statusCode ?? 502, ures.statusMessage ?? "", ures.rawHeaders));
      ures.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    up.end();
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}

// ---------- tunnel ----------

function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + (base / 2) * rand());
}

/** JS stream over `sock` that first yields `head`. Wrapping the socket handle directly would make the
 *  inner TLS read past bytes already buffered in JS (the ClientHello behind the PROXY header). */
function streamWithHead(sock: Duplex, head: Buffer): Duplex {
  const d = new Duplex({
    read() {
      sock.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      sock.write(chunk, cb);
    },
    final(cb) {
      sock.end();
      cb();
    },
    destroy(err, cb) {
      sock.destroy();
      cb(err);
    },
  });
  if (head.length) d.push(head);
  sock.on("data", (c: Buffer) => {
    if (!d.push(c)) sock.pause();
  });
  sock.on("end", () => d.push(null));
  sock.on("close", () => d.destroy());
  sock.on("error", (e) => d.destroy(e));
  return d;
}

export function startTunnel(deps: TunnelDeps): TunnelHandle {
  const proxy = localProxy(deps);
  let stopped = false;
  let attempt = 0;
  let control: TLSSocket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let generation = 0;
  const dataSockets = new Set<Socket>();

  const schedule = (err: string) => {
    if (stopped) return;
    setTunnelState("error", err);
    const wait = backoffMs(attempt++);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), wait);
    retryTimer.unref?.();
  };

  const openData = async (id: string, relay: string, pin: string | null) => {
    const ctx = deps.secureContext();
    if (!ctx) return;
    let sock: TLSSocket;
    try {
      sock = await connectPinned(relay, pin);
    } catch {
      return;
    }
    if (stopped) return void sock.destroy();
    dataSockets.add(sock);
    sock.on("close", () => dataSockets.delete(sock));
    sock.on("error", () => sock.destroy());
    sock.write(`${JSON.stringify({ t: "data", id })}\n`);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), DATA_HEADER_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let r: ProxyParse;
      try {
        r = parseProxyV2(buf);
      } catch {
        clearTimeout(timer);
        sock.destroy();
        return;
      }
      if (!r.done) return;
      clearTimeout(timer);
      sock.off("data", onData);
      sock.pause();
      const ip = r.header.srcAddr ?? "0.0.0.0";
      const secure = new tls.TLSSocket(streamWithHead(sock, buf.subarray(r.consumed)) as unknown as Socket, { isServer: true, secureContext: ctx, ALPNProtocols: ["http/1.1"] });
      clientIp.set(secure, ip);
      clientDelta(1);
      let counted = true;
      const done = () => {
        if (!counted) return;
        counted = false;
        clientDelta(-1);
        sock.destroy();
      };
      secure.on("close", done);
      secure.on("error", () => secure.destroy());
      proxy.emit("connection", secure);
    };
    sock.on("data", onData);
  };

  const connect = async () => {
    if (stopped) return;
    const gen = ++generation;
    setTunnelState("connecting");
    let tok: RelayToken;
    try {
      tok = await deps.fetchToken();
    } catch (e) {
      return schedule(e instanceof Error ? e.message : String(e));
    }
    if (stopped || gen !== generation) return;
    const pin = deps.configuredPin() ?? tok.pin;
    if (!pin) return schedule("relay_pin_missing");
    patchCloudStatus({ host: tok.host });
    let sock: TLSSocket;
    try {
      sock = await connectPinned(tok.relay, pin);
    } catch (e) {
      return schedule(e instanceof Error ? e.message : String(e));
    }
    if (stopped || gen !== generation) return void sock.destroy();
    const previous = control;
    control = sock;
    let line = "";
    let watchdog: NodeJS.Timeout | null = null;
    const pet = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => sock.destroy(new Error("relay_silent")), PING_SILENCE_MS);
      watchdog.unref?.();
    };
    let lastErr: string | null = null;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      pet();
      line += chunk;
      if (line.length > MAX_LINE && !line.includes("\n")) return void sock.destroy(new Error("relay_line_too_long"));
      let nl: number;
      while ((nl = line.indexOf("\n")) >= 0) {
        const raw = line.slice(0, nl);
        line = line.slice(nl + 1);
        let msg: { t?: string; id?: string; error?: string };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (msg.t === "ok") {
          attempt = 0;
          setTunnelState("online", null);
          if (previous && previous !== sock) previous.destroy();
          const refreshIn = Math.max(60, tok.exp - REFRESH_BEFORE_S - Math.floor(deps.now() / 1000)) * 1000;
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => void connect(), Math.min(refreshIn, 2 ** 31 - 1));
          refreshTimer.unref?.();
        } else if (msg.t === "err") {
          lastErr = `relay_${msg.error ?? "error"}`;
          sock.destroy();
        } else if (msg.t === "ping") {
          sock.write(`${JSON.stringify({ t: "pong" })}\n`);
        } else if (msg.t === "dial" && typeof msg.id === "string" && /^[0-9a-f]{24}$/.test(msg.id)) {
          void openData(msg.id, tok.relay, pin);
        }
      }
    });
    sock.on("error", (e) => {
      lastErr ??= e.message;
    });
    sock.on("close", () => {
      if (watchdog) clearTimeout(watchdog);
      if (control !== sock) return; // replaced by a refreshed connection
      control = null;
      schedule(lastErr ?? "relay_closed");
    });
    pet();
    sock.write(`${JSON.stringify({ t: "hello", token: tok.token })}\n`);
  };

  void connect();

  return {
    stop() {
      stopped = true;
      generation++;
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      control?.destroy();
      control = null;
      for (const s of dataSockets) s.destroy();
      dataSockets.clear();
      proxy.close();
      setTunnelState("off", null);
    },
    refresh() {
      if (stopped) return;
      attempt = 0;
      if (retryTimer) clearTimeout(retryTimer);
      void connect();
    },
  };
}

/** Token from the push service: POST /v1/relay/token with the hub JWT. */
export async function fetchRelayToken(): Promise<RelayToken> {
  const { cloudEndpoints, hubJwt } = await import("./identity");
  const r = await fetch(`${cloudEndpoints().api}/v1/relay/token`, { method: "POST", headers: { authorization: `Bearer ${hubJwt("vatra-relay-token")}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(`relay_token_${r.status}${j.error ? `_${j.error}` : ""}`);
  }
  const j = (await r.json()) as Partial<RelayToken>;
  if (!j.token || !j.relay || !j.host || typeof j.exp !== "number") throw new Error("relay_token_invalid");
  return { token: j.token, exp: j.exp, relay: j.relay, pin: j.pin ?? null, host: j.host };
}
