import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { deviceIdFromRequest, espAuthorized } from "@/lib/esp/auth";
import { currentView, nextView, showMessage, togglePause } from "@/lib/esp/gallery";
import { canOpenDoor, homeActorOrOwner, journalUserId, ownerActor } from "@/lib/home/access";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { loadButtonBindings } from "@/lib/home/button-bindings";
import { runButtonAction } from "@/lib/home/button-run";
import { ha } from "@/lib/home/ha-client";
import { drinkGlass, undoGlass } from "@/lib/nutrition/water-actions";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const Q = z.object({
  node: z.string().regex(/^[a-z0-9-]{1,32}$/),
  click: z.enum(["single", "double", "long", "1", "2", "3", "4", "5"]),
  /** boot = ESP32 BOOT button, water = ESP32 case switch (fixed meaning),
   *  desk = the Pi GPIO button whose gestures are configured on /home. */
  btn: z.enum(["boot", "water", "desk"]).default("boot"),
});

// POST /api/esp/button?node=…&click=single|double|long&k=…
//   single → next view        double → pause/resume gallery
//   long   → toggle ambilight movie mode (via HA scripts already installed)
// &btn=water (case switch on GPIO13): single → +250 ml, double → +100 ml (a
//   sip, not a whole glass), long → undo last entry.
//   Reply carries `led` so the firmware can blink the switch LED 1×/2×.
export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return NextResponse.json({ ok: false, error: "bad query" }, { status: 400 });
  const { node, click, btn } = p.data;
  let result = "";
  try {
    if (btn === "desk") {
      const g = click === "single" ? "1" : click === "double" ? "2" : click;
      const action = (await loadButtonBindings()).gestures[g] ?? { type: "none" as const };
      // the desk button's gestures may open/arm the intercom; shared-token hardware is the
      // owner's, but a paired device replaying this route acts as its bound member
      if (action.type === "intercom_open" || action.type === "intercom_arm") {
        const actor = await homeActorOrOwner(req, deviceIdFromRequest(req) === null);
        if (!actor) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        if (!canOpenDoor(actor)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
      const r = await runButtonAction(action, `button:${node}`);
      await db.insert(auditLog).values({ accountId: "home", action: "esp.button", target: node, status: "ok", message: `desk ${g} -> ${r.result}` });
      return NextResponse.json({ ok: true, result: r.result, led: r.led, action: r.action.type });
    }
    if (btn === "water") {
      // The case switch is the owner's: it logs into their journal.
      const o = await ownerActor();
      const uid = o ? journalUserId(o) : null;
      const r = click === "long" ? await undoGlass("esp-button", uid) : await drinkGlass(click === "double" ? 100 : 250, "esp-button", uid);
      result = `${r.action} ${r.ml} ml -> ${r.water.ml}/${r.water.targetMl}`;
      await db.insert(auditLog).values({ accountId: "home", action: "esp.button", target: node, status: "ok", message: `water ${click} -> ${result}` });
      return NextResponse.json({ ok: true, result, led: r.action === "add" ? 1 : r.action === "undo" ? 2 : 3, ml: r.water.ml, target: r.water.targetMl, underPace: r.water.underPace });
    }
    if (click === "single") result = `view ${nextView(node)}`;
    else if (click === "double") result = togglePause(node) ? "paused" : "resumed";
    else {
      const h = await ha.state("light.hyperhdr").catch(() => null);
      const turningOn = ambilightStatus(h) !== "movie";
      await ha.runScript(turningOn ? "movie_mode_on" : "movie_mode_off");
      showMessage(node, "Ambilight", turningOn ? "Movie mode pornit" : "Ambilight oprit", 3);
      result = turningOn ? "movie on" : "movie off";
      pushActivity({ at: Date.now(), kind: "scene", text: `buton ESP: ${result}` });
    }
    await db.insert(auditLog).values({ accountId: "home", action: "esp.button", target: node, status: "ok", message: `${click} -> ${result}` });
    return NextResponse.json({ ok: true, result, view: currentView(node) });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action: "esp.button", target: node, status: "error", message: error });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
