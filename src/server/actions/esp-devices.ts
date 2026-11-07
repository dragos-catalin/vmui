"use server";

import { demoRefusal } from "@/lib/demo/mode";
import { adoptEsp, addToHa, discoverEsp, isLanHost, probeEsp, type AdoptResult, type EspFound, type EspProbe, type HaAdd } from "@/lib/firmware/adopt";
import { listImages, type FirmwareImage } from "@/lib/firmware/store";
import { HomeAccessError, journalUserId, requireOwner } from "@/lib/home/access";
import { household } from "@/lib/household";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Fail = { ok: false; error: string };
const forbidden = (e: unknown): Fail => ({ ok: false, error: e instanceof HomeAccessError ? "forbidden" : "failed" });

const host = z.string().trim().toLowerCase().max(80).refine(isLanHost, "bad_host");

/** Owner-only: Vatra / ESPHome boards on the LAN (mDNS) and the firmware the hub can install. */
export async function scanEspAction(): Promise<{ ok: true; data: { found: EspFound[]; images: FirmwareImage[]; secureUrl: string | null } } | Fail> {
  try {
    await requireOwner();
    const pub = household().publicUrl;
    return { ok: true, data: { found: await discoverEsp(), images: listImages(), secureUrl: pub.startsWith("https://") ? pub : null } };
  } catch (e) {
    return forbidden(e);
  }
}

export async function probeEspAction(raw: { host: string }): Promise<{ ok: true; data: EspProbe | null } | Fail> {
  const p = z.object({ host }).safeParse(raw);
  if (!p.success) return { ok: false, error: "bad_host" };
  try {
    await requireOwner();
    return { ok: true, data: await probeEsp(p.data.host) };
  } catch (e) {
    return forbidden(e);
  }
}

const adoptInput = z.object({ host, name: z.string().trim().max(64).optional(), addHa: z.boolean().default(true) });

/** Owner-only: give the board a scoped token + the hub address, then offer it to Home Assistant. */
export async function adoptEspAction(raw: { host: string; name?: string; addHa?: boolean }): Promise<{ ok: true; data: Extract<AdoptResult, { ok: true }> } | Fail> {
  const demo = demoRefusal();
  if (demo) return demo;
  const p = adoptInput.safeParse(raw);
  if (!p.success) return { ok: false, error: "bad_host" };
  try {
    const a = await requireOwner();
    const r = await adoptEsp({ host: p.data.host, ...(p.data.name ? { name: p.data.name } : {}), addHa: p.data.addHa, by: a.email || a.displayName || a.userId, ownerUserId: journalUserId(a) });
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath("/home");
    return { ok: true, data: r };
  } catch (e) {
    return forbidden(e);
  }
}

/** Retry the Home Assistant half on its own (e.g. HA was down during adoption). */
export async function addEspToHaAction(raw: { host: string }): Promise<{ ok: true; data: HaAdd } | Fail> {
  const p = z.object({ host }).safeParse(raw);
  if (!p.success) return { ok: false, error: "bad_host" };
  try {
    await requireOwner();
    return { ok: true, data: await addToHa(p.data.host) };
  } catch (e) {
    return forbidden(e);
  }
}
