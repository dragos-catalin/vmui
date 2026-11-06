import "server-only";
import { screenText } from "@/lib/home/device-text";

import type { MealRow } from "@/lib/db/schema";
import { credential } from "@/lib/home/credentials";
import { ha } from "@/lib/home/ha-client";
import { computeTargets, dailyTotals, dayOf, lastCoachMessage, loadProfile, mealsForDay, streakDays, type DayTotals, type Targets } from "./store";
import { waterSummary, type WaterSummary } from "./water";
import { ownerPhoneSensor } from "@/lib/household";

export interface NutritionSummary {
  day: string;
  targets: Targets;
  today: DayTotals;
  remaining: { calories: number; protein: number; carbs: number; fats: number };
  /** kcal eaten minus (BMR + active kcal from the phone), when HC gives active kcal. */
  balance: number | null;
  activeKcal: number | null;
  meals: Array<Pick<MealRow, "id" | "name" | "mealType" | "calories" | "protein" | "carbs" | "fats" | "confidence" | "source"> & { at: number }>;
  week: DayTotals[];
  streak: number;
  coach: { at: number; kind: string; message: string } | null;
  water: WaterSummary;
}

const SCALE_RE = /^sensor\..*scale_weight$/;

/** Latest scale weight from HA. The ESPHome sensor resets to `unknown` on
 *  every board reboot, so when the live state is empty the last numeric
 *  value in 14 days of recorder history is used. Null when HA is down or
 *  the scale never reported; the caller falls back to the profile weight. */
export async function scaleWeightKg(): Promise<number | null> {
  try {
    const all = (await ha.states()).filter((x) => SCALE_RE.test(x.entity_id));
    const live = all.find((x) => Number.isFinite(Number(x.state)));
    if (live) return Number(live.state);
    const id = all[0]?.entity_id;
    if (!id) return null;
    // HA's history API returns [] when `since` predates the entity's first
    // recorded state (observed on 2026.9.1: 1 d -> 33 rows, 2 d -> []), so
    // widen the window step by step instead of asking for 14 d once.
    for (const days of [1, 3, 7, 14, 30]) {
      const hist = await ha.history(id, new Date(Date.now() - days * 86_400_000));
      const rows = hist[0] ?? [];
      const last = rows.map((p) => Number(p.state)).filter((v) => Number.isFinite(v) && v > 20).at(-1);
      if (last !== undefined) return last;
    }
    return null;
  } catch {
    return null;
  }
}

export async function activeKcalToday(): Promise<number | null> {
  try {
    const id = ownerPhoneSensor("active_calories_burned");
    if (!id) throw new Error("no owner phone configured");
    const s = await ha.state(id);
    const v = Number(s.state);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** `scope` = whose journal: null for a single-user install; `{ userId, isOwner }` for a family member.
 *  The scale weight and HA active-kcal are household sensors and only apply to the owner. */
export async function nutritionSummary(scope: { userId: string; isOwner: boolean } | null = null): Promise<NutritionSummary> {
  const day = dayOf();
  const uid = scope?.userId ?? null;
  const owner = scope?.isOwner ?? true;
  const [profile, weight, active, list, week, streak, coach] = await Promise.all([
    loadProfile(uid, owner),
    owner ? scaleWeightKg() : Promise.resolve(null),
    owner ? activeKcalToday() : Promise.resolve(null),
    mealsForDay(day, uid),
    dailyTotals(7, day, uid),
    streakDays(uid),
    owner ? lastCoachMessage() : Promise.resolve(null),
  ]);
  const targets = computeTargets(profile, weight);
  const water = await waterSummary(targets.weightKg, active, new Date(), uid);
  const today = week[week.length - 1] ?? { day, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, meals: 0 };
  return {
    day,
    targets,
    today,
    remaining: {
      calories: targets.calories - today.calories,
      protein: targets.protein - today.protein,
      carbs: targets.carbs - today.carbs,
      fats: targets.fats - today.fats,
    },
    activeKcal: active,
    balance: active === null ? null : Math.round(today.calories - (targets.bmr + active)),
    meals: list.map((m) => ({ id: m.id, at: m.at.getTime(), name: m.name, mealType: m.mealType, calories: m.calories, protein: m.protein, carbs: m.carbs, fats: m.fats, confidence: m.confidence, source: m.source })),
    week,
    streak,
    coach,
    water,
  };
}

/** Mirror the day into Home Assistant as plain sensors via the REST states
 *  API (no MQTT client needed; HA keeps them until restart, and every meal
 *  or poll re-posts). Entities: sensor.vmui_nutrition_*. */
export async function publishToHa(s: NutritionSummary): Promise<void> {
  if (!credential("HA_TOKEN")) return;
  const post = (id: string, state: number | string, attributes: Record<string, unknown>) =>
    ha.setState(`sensor.vmui_nutrition_${id}`, String(state), { friendly_name: screenText().haNutrition(id.replace(/_/g, " ")), ...attributes }).catch(() => undefined);
  await Promise.all([
    post("calories_today", s.today.calories, { unit_of_measurement: "kcal", icon: "mdi:food-apple", state_class: "total_increasing", target: s.targets.calories, meals: s.today.meals }),
    post("calories_remaining", s.remaining.calories, { unit_of_measurement: "kcal", icon: "mdi:scale-balance" }),
    post("protein_today", s.today.protein, { unit_of_measurement: "g", icon: "mdi:food-steak", target: s.targets.protein }),
    post("carbs_today", s.today.carbs, { unit_of_measurement: "g", icon: "mdi:bread-slice", target: s.targets.carbs }),
    post("fats_today", s.today.fats, { unit_of_measurement: "g", icon: "mdi:oil", target: s.targets.fats }),
    post("target_calories", s.targets.calories, { unit_of_measurement: "kcal", icon: "mdi:target", bmr: s.targets.bmr, tdee: s.targets.tdee, weight_kg: s.targets.weightKg, weight_source: s.targets.weightSource }),
    post("streak", s.streak, { unit_of_measurement: "zile", icon: "mdi:fire" }),
    post("last_meal", s.meals.at(-1)?.name ?? "—", { icon: "mdi:silverware-fork-knife", at: s.meals.at(-1)?.at ?? null, calories: s.meals.at(-1)?.calories ?? null }),
    post("water_today", s.water.ml, { unit_of_measurement: "mL", device_class: "volume", icon: "mdi:cup-water", state_class: "total_increasing", target: s.water.targetMl, glasses: s.water.glasses, last_at: s.water.lastAt, under_pace: s.water.underPace }),
  ]);
}
