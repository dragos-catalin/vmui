import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { ownerTokenAuthorized } from "@/lib/home/access";
import { ha } from "@/lib/home/ha-client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// PC relay for the phone. The Windows tray app (apps/desktop) subscribes to
// vmui/pc/cmd on the Pi's Mosquitto and publishes its state retained on
// vmui/pc/state. vmui has no MQTT client: HA is already connected, so we
// publish through `mqtt.publish` and read the state from the MQTT sensor
// declared in pi/ha-packages/vmui_pc.yaml (sensor.vmui_pc_agent).
const PC_ACTIONS = ["lock", "sleep", "display_off", "volume", "mute", "unmute", "restart_tunnel", "unfreeze_vscode", "kill_runaway_renderer", "restart_ambilight", "restart_turzx", "restart_vmui"] as const;

const body = z.union([
  z.object({ action: z.enum(PC_ACTIONS), value: z.number().int().min(0).max(100).nullish() }),
  z.object({ action: z.literal("hyper"), commands: z.array(z.record(z.string(), z.unknown())).min(1).max(8), instances: z.array(z.number().int().min(0).max(8)).nullish() }),
  z.object({ action: z.literal("mode"), mode: z.enum(["movie", "music", "off"]) }),
]);

export async function GET(req: NextRequest) {
  if (!espAuthorized(req) || !(await ownerTokenAuthorized(req))) return new NextResponse("forbidden", { status: 403 });
  const s = await ha.state("sensor.vmui_pc_agent").catch(() => null);
  const a = (s?.attributes ?? {}) as Record<string, unknown>;
  const seen = typeof a.at === "number" ? a.at : 0;
  const online = s?.state === "online" && Date.now() / 1000 - seen < 90;
  return NextResponse.json({ online, seenAgo: seen ? Math.round(Date.now() / 1000 - seen) : null, grabber: a.grabber ?? null, source: a.source ?? null, mode: a.mode ?? null, instances: a.instances ?? [], host: a.host ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req) || !(await ownerTokenAuthorized(req))) return new NextResponse("forbidden", { status: 403 });
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  const id = Math.random().toString(36).slice(2, 10);
  const payload = JSON.stringify({ id, ...p.data, at: Math.floor(Date.now() / 1000) });
  try {
    await ha.callService("mqtt", "publish", { topic: "vmui/pc/cmd", payload, qos: 1 });
    await db.insert(auditLog).values({ accountId: "mobile", action: `pc.${p.data.action}`, target: "pc-agent", status: "ok", message: payload.slice(0, 300) });
    return NextResponse.json({ ok: true, id, result: "trimis către PC" });
  } catch (e) {
    await db.insert(auditLog).values({ accountId: "mobile", action: `pc.${p.data.action}`, target: "pc-agent", status: "error", message: String(e).slice(0, 300) });
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
