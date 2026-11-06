import { LOCALES } from "@/i18n/config";
import { db } from "@/lib/db";
import { pairedDevices } from "@/lib/db/schema";
import { deviceFromRequest } from "@/lib/devices/pairing";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** The phone registers its FCM token against its paired-device row (token rotates; the app re-posts on change). */
export async function PUT(req: NextRequest) {
  const d = await deviceFromRequest(req);
  if (!d) return apiForbidden(req);
  const p = z.object({ token: z.string().min(20).max(4096).nullable(), language: z.enum(LOCALES).optional() }).safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false }, { status: 400 });
  await db.update(pairedDevices).set({ pushToken: p.data.token, ...(p.data.language ? { language: p.data.language } : {}) }).where(eq(pairedDevices.id, d.id));
  return NextResponse.json({ ok: true });
}
