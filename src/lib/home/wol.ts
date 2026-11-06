import "server-only";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { credential } from "@/lib/home/credentials";
import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import { household } from "@/lib/household";

/** Wake the Windows PC from homepi with a magic packet (UDP 9 broadcast +
 *  directed). NIC has "Shutdown Wake-On-Lan" on and Fast Startup is off, so
 *  a powered-off PC keeps listening. */

export function pcTarget(): { mac: string; ip: string } | null {
  const mac = credential("PC_WOL_MAC");
  const ip = household().pcWolIp || credential("PC_WOL_IP") || "255.255.255.255";
  return mac ? { mac, ip } : null;
}

function magicPacket(mac: string): Buffer {
  const m = mac.split(/[:-]/).map((h) => parseInt(h, 16));
  if (m.length !== 6 || m.some((b) => Number.isNaN(b))) throw new Error(`bad MAC ${mac}`);
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(m).copy(buf, 6 + i * 6);
  return buf;
}

function send(pkt: Buffer, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.once("error", (e) => { s.close(); reject(e); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(pkt, 9, host, (e) => { s.close(); e ? reject(e) : resolve(); });
    });
  });
}

export async function pcIsUp(ip: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const c = new Socket();
    const done = (v: boolean) => { c.destroy(); resolve(v); };
    c.setTimeout(timeoutMs, () => done(false));
    c.once("error", () => done(false));
    c.connect(22, ip, () => done(true));
  });
}

export async function wakePc(by: string): Promise<{ ok: true; alreadyUp: boolean } | { ok: false; error: string }> {
  const t = pcTarget();
  if (!t) return { ok: false, error: "PC_WOL_MAC missing in credentials" };
  try {
    if (await pcIsUp(t.ip)) {
      await db.insert(auditLog).values({ accountId: "home", action: "pc.wake", target: t.ip, status: "ok", message: `already up (by ${by})` });
      return { ok: true, alreadyUp: true };
    }
    const pkt = magicPacket(t.mac);
    // three bursts: broadcast, subnet-directed broadcast and unicast to the last known IP
    for (let i = 0; i < 3; i++) {
      await Promise.all([send(pkt, "255.255.255.255"), send(pkt, t.ip.replace(/\.\d+$/, ".255")), send(pkt, t.ip)]);
      await new Promise((r) => setTimeout(r, 150));
    }
    await db.insert(auditLog).values({ accountId: "home", action: "pc.wake", target: t.mac, status: "ok", message: `magic packet sent (by ${by})` });
    pushActivity({ at: Date.now(), kind: "other", text: `PC: trezit prin Wake-on-LAN (${by})` });
    return { ok: true, alreadyUp: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action: "pc.wake", target: t.mac, status: "error", message: error });
    return { ok: false, error };
  }
}
