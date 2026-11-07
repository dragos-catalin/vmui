import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { canControlAny, isOwner, tokenActor } from "@/lib/home/access";
import { STREAM_SCRIPTS } from "@/lib/home/catalog";
import { credential } from "@/lib/home/credentials";
import { ha } from "@/lib/home/ha-client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// The installed desktop app (P9) holds only its paired-device token: no repo, no credentials.env.
// GET hands the owner's PC what its tray agent needs (the house MQTT login, HA reachability);
// POST runs one of the house scripts the tray menu offers, through the hub's own HA connection.
const SCRIPTS = ["movie_mode_on", "movie_mode_off", "music_mode", "ambilight_all", "notify_flash", "pc_wake", ...STREAM_SCRIPTS] as const;

const body = z.object({
  script: z.enum(SCRIPTS),
  variables: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const actor = await tokenActor(req);
  if (!actor) return apiError(req, "not_bound", 403);
  const owner = isOwner(actor);
  const user = credential("MQTT_USER");
  const pass = credential("MQTT_PASS");
  const haOnline = await ha.state("sun.sun").then(() => true, () => false);
  return NextResponse.json(
    {
      owner,
      haOnline,
      // the PC agent is the owner's machine only; a family member's desktop never gets the broker login
      mqtt: owner && user && pass ? { host: credential("MQTT_PUBLIC_HOST") ?? null, port: Number(credential("MQTT_PORT") ?? 1883), user, pass } : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const actor = await tokenActor(req);
  if (!actor) return apiError(req, "not_bound", 403);
  if (!canControlAny(actor)) return apiError(req, "no_room_access", 403);
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return apiError(req, "invalid_request", 400);
  const { script, variables } = p.data;
  const data: Record<string, unknown> = { entity_id: `script.${script}` };
  if (variables && Object.keys(variables).length > 0) data.variables = variables;
  try {
    // script.turn_on returns at once; `script/<name>` would block for the whole run
    await ha.callService("script", "turn_on", data);
    await db.insert(auditLog).values({ accountId: "desktop", action: `desktop.script.${script}`, target: actor.deviceId ?? actor.userId, status: "ok", message: null });
    return NextResponse.json({ ok: true });
  } catch (e) {
    await db.insert(auditLog).values({ accountId: "desktop", action: `desktop.script.${script}`, target: actor.deviceId ?? actor.userId, status: "error", message: String(e).slice(0, 300) });
    return apiError(req, "upstream_failed", 502);
  }
}
