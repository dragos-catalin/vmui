import { espAuthorized } from "@/lib/esp/auth";
import { pcIsUp, pcTarget, wakePc } from "@/lib/home/wol";
import { NextResponse, type NextRequest } from "next/server";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// GET  /api/pc/wake?k=…   -> { up }
// POST /api/pc/wake?k=…   -> send the magic packet (phone shortcut, HA rest_command, ESP)
export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const t = pcTarget();
  if (!t) return NextResponse.json({ ok: false, error: "not configured" }, { status: 500 });
  return NextResponse.json({ ok: true, up: await pcIsUp(t.ip), ip: t.ip }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const r = await wakePc(new URL(req.url).searchParams.get("by") ?? "api");
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
