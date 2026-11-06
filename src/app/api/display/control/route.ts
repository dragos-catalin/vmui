import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { canControlAny, tokenActor } from "@/lib/home/access";
import { controlCommandSchema, mayControl, runControl } from "@/lib/home/control";
import { ha } from "@/lib/home/ha-client";
import { drinkGlass, undoGlass } from "@/lib/nutrition/water-actions";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/display/control   body: a control command (lib/home/control.ts) or a kiosk-only one below.
// The Nest Hub kiosk cannot hold a session; its token acts as the owner (or the bound member).

const cmd = z.union([
  controlCommandSchema,
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("water"), ml: z.number().int().min(50).max(1000).default(250) }),
    z.object({ type: z.literal("water_undo") }),
    /** The kiosk tells HA whether it is idle so automations (and the Hub's own touch edge) share one flag. */
    z.object({ type: z.literal("idle"), on: z.boolean() }),
  ]),
]);

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const p = cmd.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message ?? "bad command" }, { status: 400 });
  const c = p.data;
  const actor = await tokenActor(req);
  if (!actor) return apiError(req, "not_bound", 403);
  try {
    switch (c.type) {
      case "water":
      case "water_undo": {
        const r = c.type === "water" ? await drinkGlass(c.ml, "nest-hub") : await undoGlass("nest-hub");
        await db.insert(auditLog).values({ accountId: "home", action: `display.${c.type}`, target: c.type, status: "ok", message: JSON.stringify(c).slice(0, 400) });
        return NextResponse.json({ ok: true, ml: r.water.ml, target: r.water.targetMl, glasses: r.water.glasses });
      }
      case "idle":
        if (!canControlAny(actor)) return apiError(req, "no_room_access", 403);
        await ha.callService("input_boolean", c.on ? "turn_on" : "turn_off", { entity_id: "input_boolean.nest_hub_idle" });
        // one row per flip would flood the audit log at 45 s idle cycles
        return NextResponse.json({ ok: true });
      default:
        if (!mayControl(actor, c)) return apiError(req, "no_room_access", 403);
        await runControl(c, "display");
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
