import "server-only";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { listNodes, showFrame } from "@/lib/esp/gallery";
import { renderWater } from "@/lib/esp/views";
import { deviceText, screenText } from "@/lib/home/device-text";
import { setNutritionEvent } from "./events";
import { dayOf } from "./store";
import { nutritionSummary, publishToHa } from "./summary";
import { addWater, GLASS_ML, undoWater, type WaterSummary } from "./water";

export interface WaterResult {
  ok: true;
  action: "add" | "undo" | "noop";
  ml: number;
  water: WaterSummary;
}

/** Show the water card on every ESP display for 8 s, then the gallery resumes. */
function espCard(action: WaterResult["action"], w: WaterSummary): void {
  const card = { action, ml: w.ml, targetMl: w.targetMl, glasses: w.glasses, entries: w.entries, week: w.week, lastAt: w.lastAt };
  for (const n of listNodes()) showFrame(n.name, () => renderWater(card), 8);
}

const fmt = (ml: number) => (ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 ? 2 : 1).replace(/\.?0+$/, "")} L` : `${ml} ml`);

const scopeOf = (userId: string | null, isOwner: boolean) => (userId ? { userId, isOwner } : null);

/** One glass in: log, screen card, HA mirror, audit. Shared by the desk
 *  button, the phone route and the /home card so all three behave the same.
 *  `userId` = whose journal (null on single-user installs). The desk screens,
 *  the HA sensors and the activity feed are the household's, so they only
 *  reflect the owner's glasses. */
export async function drinkGlass(ml = GLASS_ML, source = "web", userId: string | null = null, isOwner = true): Promise<WaterResult> {
  await addWater(ml, source, Date.now(), userId);
  const s = await nutritionSummary(scopeOf(userId, isOwner));
  const w = s.water;
  if (isOwner) {
    setNutritionEvent({ kind: "meal", at: Date.now(), name: screenText().waterAdded(fmt(ml)), text: screenText().waterTotal(fmt(w.ml), fmt(w.targetMl), w.remainingMl === 0) });
    pushActivity({ at: Date.now(), kind: "other", text: deviceText().water(ml, w.glasses, fmt(w.ml)) });
    espCard("add", w);
  }
  await db.insert(auditLog).values({ accountId: "home", action: "nutrition.water.add", target: source, status: "ok", message: `${ml} ml -> ${w.ml}/${w.targetMl}` });
  if (isOwner) publishToHa(s).catch(() => undefined);
  return { ok: true, action: "add", ml, water: w };
}

export async function undoGlass(source = "web", userId: string | null = null, isOwner = true): Promise<WaterResult> {
  const removed = await undoWater(dayOf(), userId);
  const s = await nutritionSummary(scopeOf(userId, isOwner));
  const w = s.water;
  if (isOwner) espCard(removed ? "undo" : "noop", w);
  if (removed) {
    if (isOwner) setNutritionEvent({ kind: "meal", at: Date.now(), name: "Pahar anulat", text: `${fmt(w.ml)} din ${fmt(w.targetMl)}` });
    await db.insert(auditLog).values({ accountId: "home", action: "nutrition.water.undo", target: source, status: "ok", message: `-${removed.ml} ml -> ${w.ml}/${w.targetMl}` });
    if (isOwner) publishToHa(s).catch(() => undefined);
  }
  return { ok: true, action: removed ? "undo" : "noop", ml: removed?.ml ?? 0, water: w };
}
