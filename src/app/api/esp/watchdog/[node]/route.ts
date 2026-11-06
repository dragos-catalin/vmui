import { espAuthorized } from "@/lib/esp/auth";
import { ha } from "@/lib/home/ha-client";
import { NextResponse, type NextRequest } from "next/server";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// GET /api/esp/watchdog/<node>?k=<ESP_DISPLAY_TOKEN>  -> "ok" | "reboot"
//
// Zombie-slot watchdog for the ESPHome API. Twice (2026-09-15/16) the board
// kept API slots pinned by half-open HA sockets: HA logged "connection dropped
// immediately after encrypted hello" for hours, the ESP kept fetching frames
// from us (WiFi/HTTP fine), and only a reboot freed the slots. The ESP cannot
// see this itself (its is_connected() counts the zombie), but we can: HA's
// `binary_sensor.<node>_status` says whether HA is actually subscribed. Off
// for 3 min while the ESP is polling us => "reboot". One reboot per window.
const API_DOWN_GRACE_MS = 3 * 60_000;
const apiDownSince = new Map<string, number>();

export async function GET(req: NextRequest, { params }: { params: Promise<{ node: string }> }) {
  const { node } = await params;
  if (!espAuthorized(req)) return apiForbidden(req);
  if (!/^[a-z0-9-]{1,32}$/.test(node)) return new NextResponse("bad node", { status: 400 });
  const text = (s: string) => new NextResponse(s, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  try {
    const slug = node.replace(/-/g, "_");
    // ESPHome names the status sensor after the device's friendly name; both spellings exist here.
    const cands = new Set([`binary_sensor.${slug}_status`, `binary_sensor.office_${slug}_status`]);
    const st = (await ha.states()).find((s) => cands.has(s.entity_id));
    if (!st || st.state === "on") {
      apiDownSince.delete(node);
      return text("ok");
    }
    const since = apiDownSince.get(node) ?? Date.now();
    apiDownSince.set(node, since);
    if (Date.now() - since < API_DOWN_GRACE_MS) return text("ok");
    apiDownSince.set(node, Date.now());
    return text("reboot");
  } catch {
    return text("ok");
  }
}
