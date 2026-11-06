import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { displaySettingsSchema, loadDisplaySettings, saveDisplaySettings } from "@/lib/display/settings";
import { espAuthorized } from "@/lib/esp/auth";
import { ownerTokenAuthorized } from "@/lib/home/access";
import { deviceLocale } from "@/lib/notify/i18n";
import { catalogText } from "@/lib/turzx/catalog-text";
import { loadTurzxSettings, saveTurzxSettings, turzxSettingsSchema } from "@/lib/turzx/settings";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// The desktop app (apps/desktop, Tauri) edits both screens from a native
// window. It holds the shared display token, not a session, so this mirrors
// saveTurzxSettingsAction / saveDisplaySettingsAction behind that token.
export async function GET(req: NextRequest) {
  if (!espAuthorized(req) || !(await ownerTokenAuthorized(req))) return new NextResponse("forbidden", { status: 403 });
  const [turzx, display, meta] = await Promise.all([loadTurzxSettings(), loadDisplaySettings(), catalogText(deviceLocale(req.headers.get("accept-language")))]);
  return NextResponse.json(
    { turzx, display, meta },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const body = z.union([z.object({ turzx: turzxSettingsSchema }), z.object({ display: displaySettingsSchema })]);

export async function PUT(req: NextRequest) {
  if (!espAuthorized(req) || !(await ownerTokenAuthorized(req))) return new NextResponse("forbidden", { status: 403 });
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  if ("turzx" in p.data) {
    await saveTurzxSettings(p.data.turzx);
    await db.insert(auditLog).values({ accountId: "desktop", action: "turzx.settings", target: "turzx", status: "ok", message: `${p.data.turzx.views.filter((v) => v.enabled).length} views on` });
  } else {
    await saveDisplaySettings(p.data.display);
    await db.insert(auditLog).values({ accountId: "desktop", action: "display.settings", target: "nest-hub", status: "ok", message: `${p.data.display.views.filter((v) => v.enabled).length} views on` });
  }
  return NextResponse.json({ ok: true });
}
