import { deviceIdFromRequest, espAuthorized } from "@/lib/esp/auth";
import { canOpenDoor, currentHomeActor, homeActorOrOwner } from "@/lib/home/access";
import { armAutoOpen, ignoreCall, intercomState, isAutoOpenArmed, onEspEvent, openDoor } from "@/lib/home/intercom";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const espQ = z.object({
  node: z.string().regex(/^[a-z0-9-]{1,32}$/),
  event: z.enum(["ring", "end", "opened"]),
});

// POST /api/esp/intercom?k=…&node=…&event=ring|end|opened   (from the ESP32)
//   ring answers {"open":true} while auto-open is armed, so the ESP runs the
//   talk+open sequence itself without a second round trip.
export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const p = espQ.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return NextResponse.json({ ok: false, error: "bad query" }, { status: 400 });
  const r = await onEspEvent(p.data.event, p.data.node);
  return NextResponse.json({ ok: true, ...r });
}

// GET /api/esp/intercom?k=…            state for the phone / turzx
export async function GET(req: NextRequest) {
  // shared token (ESP32, HA), a bound device, or any signed-in household member polling the card
  if (!espAuthorized(req) && !(await currentHomeActor())) return apiForbidden(req);
  const s = intercomState();
  return NextResponse.json({ ringing: s.ringingSince !== null, ringingSince: s.ringingSince, lastRingAt: s.lastRingAt, lastOpenAt: s.lastOpenAt, autoOpenUntil: s.autoOpenUntil, armed: isAutoOpenArmed(), log: s.log }, { headers: { "Cache-Control": "no-store" } });
}

const cmd = z.object({
  action: z.enum(["open", "ignore", "arm", "disarm"]),
  minutes: z.number().int().min(1).max(240).default(45),
  by: z.string().max(40).default("phone"),
});

// PUT /api/esp/intercom?k=…  body {action: open|ignore|arm|disarm, minutes?, by?}
//   Shared-token callers (ESP32, Nest Hub, HA) are the owner's own hardware and
//   act as the owner. A paired device (`Bearer vmd_`) acts as the member it is
//   bound to: children and guests may ignore a call but not open or arm the door.
export async function PUT(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const p = cmd.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: z.flattenError(p.error) }, { status: 400 });
  const { action, minutes, by } = p.data;
  if (action === "open" || action === "arm") {
    const actor = await homeActorOrOwner(req, deviceIdFromRequest(req) === null);
    if (!actor) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (!canOpenDoor(actor)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (action === "open") return NextResponse.json(await openDoor(by));
  if (action === "ignore") {
    await ignoreCall(by);
    return NextResponse.json({ ok: true });
  }
  const s = await armAutoOpen(action === "arm" ? minutes : 0, by);
  return NextResponse.json({ ok: true, autoOpenUntil: s.autoOpenUntil });
}
