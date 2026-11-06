import { notifyActor } from "@/lib/notify/auth";
import { fcmConfigured } from "@/lib/notify/fcm";
import { render } from "@/lib/notify/i18n";
import { KIND_IDS, KIND_META, loadNotifySettings, saveNotifySettings } from "@/lib/notify/settings";
import { NextResponse, type NextRequest } from "next/server";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** `meta[kind]` = colour, icon and a label in the caller's language (the desktop app renders it verbatim). */
export async function GET(req: NextRequest) {
  const who = await notifyActor(req);
  if (!who) return apiForbidden(req);
  const labels = await Promise.all(KIND_IDS.map((k) => render({ key: `kinds.${k}` }, who.locale)));
  const meta = Object.fromEntries(KIND_IDS.map((k, i) => [k, { ...KIND_META[k], label: labels[i] ?? k }]));
  return NextResponse.json({ settings: await loadNotifySettings(), meta, fcm: fcmConfigured() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const who = await notifyActor(req);
  if (!who) return apiForbidden(req);
  try {
    const s = await saveNotifySettings(await req.json());
    return NextResponse.json({ ok: true, settings: s });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "invalid" }, { status: 400 });
  }
}
