"use server";

import { APPLIANCE_PROFILE_IDS, type ApplianceProfile } from "@/lib/devices/appliance-scopes";
import { mintApplianceToken } from "@/lib/devices/pairing";
import { HomeAccessError, journalUserId, requireOwner } from "@/lib/home/access";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const input = z.object({ profile: z.enum(APPLIANCE_PROFILE_IDS as [ApplianceProfile, ...ApplianceProfile[]]), name: z.string().trim().min(1).max(64) });

type Result = { ok: true; data: { id: string; token: string } } | { ok: false; error: string };

/** Owner-only: a scoped token for one appliance. The clear token is returned once and never stored. */
export async function mintApplianceAction(raw: { profile: string; name: string }): Promise<Result> {
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try {
    const a = await requireOwner();
    const r = await mintApplianceToken(p.data.profile, p.data.name, a.email || a.displayName || a.userId, journalUserId(a));
    revalidatePath("/home");
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: e instanceof HomeAccessError ? "forbidden" : "failed" };
  }
}
