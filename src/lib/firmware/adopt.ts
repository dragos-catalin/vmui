import "server-only";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type { ApplianceProfile } from "@/lib/devices/appliance-scopes";
import { mintApplianceToken, revokeDevice } from "@/lib/devices/pairing";
import { ha } from "@/lib/home/ha-client";
import { household } from "@/lib/household";
import mdns from "multicast-dns";
import { networkInterfaces } from "node:os";
import { IMAGE_ID, kindOf } from "./store";

// Devices -> Add (P6-04). A freshly flashed Vatra board announces itself on mDNS as an ESPHome
// node (_esphomelib._tcp, TXT project_name=vatra.*). Adoption = the hub mints an appliance token
// scoped to the board's routes and writes hub URL + token through the board's local web_server
// (firmware/README.md). The board refuses a second adoption until someone holds its button 10 s.
// Then the same board is offered to Home Assistant through the esphome config flow.

export type EspFound = { host: string; ip: string | null; name: string; friendlyName: string | null; project: string | null; version: string | null; mac: string | null; vatra: boolean };
export type EspProbe = { image: string; version: string; adopted: boolean };
export type HaAdd = "added" | "already" | "needs_key" | "unavailable" | "failed";
export type AdoptResult = { ok: true; deviceId: string; image: string; ha: HaAdd } | { ok: false; error: "unreachable" | "not_vatra" | "already_adopted" | "refused" | "bad_host" };

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;
const LOCAL_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.local$/i;

/** The hub only talks to boards on the LAN: a private IPv4 or an mDNS .local name. Anything
 *  else (public hosts, metadata addresses, ports, paths) is refused before a socket opens. */
export const isLanHost = (h: string): boolean => (PRIVATE_V4.test(h) && h.split(".").every((o) => Number(o) <= 255)) || LOCAL_NAME.test(h);

/** TXT records of an ESPHome node ("project_name=vatra.display", ...) to a map. */
export function parseTxt(chunks: ReadonlyArray<Buffer | string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of chunks) {
    const s = typeof c === "string" ? c : c.toString("utf8");
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
  }
  return out;
}

type Answer = { name: string; type: string; data: unknown };

/** Folds mDNS answers (PTR -> SRV -> TXT/A) into one entry per ESPHome node. */
export function collectEsp(answers: readonly Answer[], into = new Map<string, EspFound>()): Map<string, EspFound> {
  const srv = new Map<string, { target: string; port: number }>();
  const txt = new Map<string, Record<string, string>>();
  const addr = new Map<string, string>();
  const instances = new Set<string>();
  for (const a of answers) {
    if (a.type === "PTR" && a.name.toLowerCase() === "_esphomelib._tcp.local" && typeof a.data === "string") instances.add(a.data);
    else if (a.type === "SRV" && a.data && typeof a.data === "object") srv.set(a.name, a.data as { target: string; port: number });
    else if (a.type === "TXT" && Array.isArray(a.data)) txt.set(a.name, parseTxt(a.data as Buffer[]));
    else if (a.type === "A" && typeof a.data === "string") addr.set(a.name.toLowerCase(), a.data);
  }
  for (const k of srv.keys()) if (k.toLowerCase().endsWith("._esphomelib._tcp.local")) instances.add(k);
  for (const inst of instances) {
    const s = srv.get(inst);
    const t = txt.get(inst) ?? {};
    const name = inst.split(".")[0] ?? inst;
    const host = (s?.target ?? `${name}.local`).toLowerCase();
    const ip = addr.get(host) ?? into.get(name)?.ip ?? null;
    const project = t.project_name ?? into.get(name)?.project ?? null;
    into.set(name, {
      host,
      ip,
      name,
      friendlyName: t.friendly_name ?? into.get(name)?.friendlyName ?? null,
      project,
      version: t.project_version ?? into.get(name)?.version ?? null,
      mac: t.mac ?? into.get(name)?.mac ?? null,
      vatra: !!project?.startsWith("vatra."),
    });
  }
  return into;
}

/** ESPHome nodes answering on the LAN within `ms`. Vatra boards first. */
export async function discoverEsp(ms = 2500): Promise<EspFound[]> {
  const found = new Map<string, EspFound>();
  const m = mdns();
  await new Promise<void>((done) => {
    m.on("response", (r: { answers?: Answer[]; additionals?: Answer[] }) => collectEsp([...(r.answers ?? []), ...(r.additionals ?? [])], found));
    m.on("error", () => done());
    m.query({ questions: [{ name: "_esphomelib._tcp.local", type: "PTR" }] });
    setTimeout(() => m.query({ questions: [{ name: "_esphomelib._tcp.local", type: "PTR" }] }), 800);
    setTimeout(done, ms);
  });
  m.destroy();
  return [...found.values()].sort((a, b) => Number(b.vatra) - Number(a.vatra) || a.name.localeCompare(b.name));
}

const deviceUrl = (host: string, path: string) => `http://${host}${path}`;
const entity = (domain: string, name: string) => `/${domain}/${encodeURIComponent(name)}`;

async function readState(host: string, domain: string, name: string): Promise<string | null> {
  const res = await fetch(deviceUrl(host, entity(domain, name)), { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as { value?: unknown; state?: unknown } | null;
  const v = j?.value ?? j?.state;
  return typeof v === "string" ? v : null;
}

/** What the board says it runs, read from its web_server. Null when it is not a Vatra board. */
export async function probeEsp(host: string): Promise<EspProbe | null> {
  if (!isLanHost(host)) return null;
  try {
    const fw = await readState(host, "text_sensor", "Vatra firmware");
    const m = fw ? /^([a-z0-9-]+)@(.+)$/.exec(fw.trim()) : null;
    if (!m?.[1] || !m[2] || !IMAGE_ID.test(m[1])) return null;
    const adopted = (await readState(host, "text_sensor", "Vatra adopted")) === "yes";
    return { image: m[1], version: m[2], adopted };
  } catch {
    return null;
  }
}

async function setText(host: string, name: string, value: string): Promise<boolean> {
  const res = await fetch(`${deviceUrl(host, entity("text", name))}/set?value=${encodeURIComponent(value)}`, { method: "POST", signal: AbortSignal.timeout(5000), cache: "no-store" });
  return res.ok;
}

const v4 = (ip: string) => ip.split(".").map(Number);
const sameSubnet = (a: string, b: string, netmask: string) => {
  const [x, y, m] = [v4(a), v4(b), v4(netmask)];
  return x.length === 4 && y.length === 4 && m.length === 4 && x.every((o, i) => (o & (m[i] ?? 0)) === ((y[i] ?? 0) & (m[i] ?? 0)));
};

/** The address a board on `deviceIp`'s network can reach the hub at: the hub's own IPv4 on that
 *  subnet, else the household public URL, else the first private IPv4. Port = the hub's port. */
export function hubUrlFor(deviceIp: string | null, nets = networkInterfaces(), port = Number(process.env.PORT ?? 3737)): string | null {
  const addrs = Object.values(nets).flatMap((l) => l ?? []).filter((n) => n.family === "IPv4" && !n.internal);
  const match = deviceIp ? addrs.find((n) => sameSubnet(n.address, deviceIp, n.netmask)) : undefined;
  if (match) return `http://${match.address}:${port}`;
  const pub = household().publicUrl;
  if (pub?.startsWith("http://")) return pub;
  const any = addrs.find((n) => PRIVATE_V4.test(n.address));
  return any ? `http://${any.address}:${port}` : null;
}

export const profileFor = (image: string): ApplianceProfile => (kindOf(image) === "button" ? "deskButton" : "esp32");

/** Offers the board to Home Assistant (esphome config flow on its native API port). */
export async function addToHa(host: string): Promise<HaAdd> {
  if (!ha.configured()) return "unavailable";
  try {
    const first = await ha.flowStart("esphome");
    if (first.type === "abort") return first.reason === "already_configured" ? "already" : "failed";
    if (!first.flow_id) return "failed";
    const step = await ha.flowStep(first.flow_id, { host, port: 6053 });
    if (step.type === "create_entry") return "added";
    if (step.type === "abort") return step.reason === "already_configured" || step.reason === "already_in_progress" ? "already" : "failed";
    // a form after the host step = HA wants the API encryption key; the board has none compiled
    // in, so the owner finishes it in HA (it provisions the key). Leave no half-open flow behind.
    await ha.flowAbort(first.flow_id);
    return step.type === "form" ? "needs_key" : "failed";
  } catch {
    return "failed";
  }
}

/** Mint, write, verify; revoke the token if the board did not take it. */
export async function adoptEsp(input: { host: string; name?: string; hubUrl?: string; by: string; ownerUserId: string | null; addHa?: boolean }): Promise<AdoptResult> {
  const { host } = input;
  if (!isLanHost(host)) return { ok: false, error: "bad_host" };
  const probe = await probeEsp(host);
  if (!probe) return { ok: false, error: (await reachable(host)) ? "not_vatra" : "unreachable" };
  if (probe.adopted) return { ok: false, error: "already_adopted" };
  const hub = input.hubUrl ?? hubUrlFor(PRIVATE_V4.test(host) ? host : null);
  if (!hub) return { ok: false, error: "refused" };
  const name = (input.name?.trim() || host.replace(/\.local$/, "")).slice(0, 64);
  const { id, token } = await mintApplianceToken(profileFor(probe.image), name, input.by, input.ownerUserId);
  let taken = false;
  try {
    taken = (await setText(host, "Vatra hub", hub)) && (await setText(host, "Vatra token", token)) && (await readState(host, "text_sensor", "Vatra adopted").catch(() => null)) === "yes";
  } catch {
    taken = false;
  }
  if (!taken) {
    await revokeDevice(id, "adoption failed");
    return { ok: false, error: "refused" };
  }
  const haResult = input.addHa === false ? "unavailable" : await addToHa(host);
  await db.insert(auditLog).values({ accountId: "devices", action: "device.esp.adopt", target: id, status: "ok", message: `${name} ${probe.image}@${probe.version} at ${host}; ha ${haResult}` });
  return { ok: true, deviceId: id, image: probe.image, ha: haResult };
}

async function reachable(host: string): Promise<boolean> {
  try {
    const r = await fetch(deviceUrl(host, "/"), { signal: AbortSignal.timeout(3000), cache: "no-store" });
    return r.status > 0;
  } catch {
    return false;
  }
}
