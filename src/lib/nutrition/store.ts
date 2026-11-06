import "server-only";

import { db } from "@/lib/db";
import { coachMessages, meals, nutritionProfiles, turzxSettings, type MealRow } from "@/lib/db/schema";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { NUTRITION_PROFILE_DEFAULTS, nutritionProfileSchema, type MealInput, type NutritionProfile } from "./schema";
import { householdTimeZone } from "@/lib/household";

// turzx_settings is the app's small key/value table; rows 1-3 are turzx,
// pomodoro, copilot signals. Row 4 = nutrition profile.
// turzx_settings rows: 1 turzx, 2 (free), 3 copilot signals, 4 display, 5 nutrition, 6 notify, 7 button bindings
const ROW_ID = 5;
const tz = () => householdTimeZone();

export function dayOf(at: number | Date = Date.now()): string {
  // en-CA gives YYYY-MM-DD; keep the day boundary in the user's timezone, not UTC.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** `userId === null` = single-user install (legacy row 5). Members get their own row; a
 *  member with none yet starts from the defaults, except the owner who inherits row 5. */
export async function loadProfile(userId: string | null = null, isOwner = userId === null): Promise<NutritionProfile> {
  if (userId !== null) {
    const mine = await db.select().from(nutritionProfiles).where(eq(nutritionProfiles.userId, userId)).get();
    if (mine) {
      const p = nutritionProfileSchema.safeParse(JSON.parse(mine.json));
      if (p.success) return p.data;
    }
    if (!isOwner) return NUTRITION_PROFILE_DEFAULTS;
  }
  const row = await db.select().from(turzxSettings).where(eq(turzxSettings.id, ROW_ID)).get();
  if (!row) return NUTRITION_PROFILE_DEFAULTS;
  const p = nutritionProfileSchema.safeParse(JSON.parse(row.json));
  return p.success ? p.data : NUTRITION_PROFILE_DEFAULTS;
}

export async function saveProfile(p: NutritionProfile, userId: string | null = null): Promise<void> {
  const json = JSON.stringify(nutritionProfileSchema.parse(p));
  if (userId !== null) {
    await db.insert(nutritionProfiles).values({ userId, json }).onConflictDoUpdate({ target: nutritionProfiles.userId, set: { json, updatedAt: new Date() } });
    return;
  }
  await db.insert(turzxSettings).values({ id: ROW_ID, json }).onConflictDoUpdate({ target: turzxSettings.id, set: { json, updatedAt: new Date() } });
}

// ---------------------------------------------------------------- targets

export interface Targets {
  weightKg: number;
  weightSource: "scale" | "fallback";
  ageYears: number;
  bmr: number;
  tdee: number;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber: number;
}

const ACTIVITY_FACTOR = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 } as const;
const GOAL_FACTOR = { maintain: 1.0, lose: 0.8, gain: 1.1 } as const;

/** Mifflin-St Jeor (1990) — more accurate than the Harris-Benedict mancai
 *  used (validated on modern populations; ~10 % tighter error). Weight comes
 *  from the OKOK scale via HA when available so the target follows the body,
 *  not a number typed once. */
export function computeTargets(p: NutritionProfile, weightKg: number | null, at = new Date()): Targets {
  const w = weightKg ?? p.weightKgFallback;
  const bd = new Date(p.birthDate);
  let age = at.getFullYear() - bd.getFullYear();
  if (at < new Date(at.getFullYear(), bd.getMonth(), bd.getDate())) age -= 1;
  const bmr = 10 * w + 6.25 * p.heightCm - 5 * age + (p.sex === "m" ? 5 : -161);
  const tdee = bmr * ACTIVITY_FACTOR[p.activity];
  const calories = Math.round(p.targetCaloriesOverride ?? tdee * GOAL_FACTOR[p.goal]);
  return {
    weightKg: Math.round(w * 10) / 10,
    weightSource: weightKg === null ? "fallback" : "scale",
    ageYears: age,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calories,
    protein: Math.round((calories * p.macroSplit.protein) / 4),
    carbs: Math.round((calories * p.macroSplit.carbs) / 4),
    fats: Math.round((calories * p.macroSplit.fats) / 9),
    // EFSA adequate intake for adults
    fiber: 25,
  };
}

// ---------------------------------------------------------------- meals

const forUser = (userId: string | null) => (userId === null ? undefined : eq(meals.userId, userId));

export async function addMeal(input: MealInput): Promise<{ meal: MealRow; created: boolean }> {
  const at = input.at ?? Date.now();
  if (input.clientId) {
    const existing = await db.select().from(meals).where(and(eq(meals.clientId, input.clientId), forUser(input.userId ?? null))).get();
    if (existing) return { meal: existing, created: false };
  }
  const row: typeof meals.$inferInsert = {
    id: randomUUID(),
    at: new Date(at),
    day: dayOf(at),
    name: input.name,
    mealType: input.mealType,
    calories: input.calories,
    protein: input.protein,
    carbs: input.carbs,
    fats: input.fats,
    fiber: input.fiber,
    confidence: input.confidence,
    items: JSON.stringify(input.items),
    notes: input.notes,
    source: input.source,
    clientId: input.clientId ?? null,
    syncedToHealthConnect: input.syncedToHealthConnect,
    userId: input.userId ?? null,
  };
  await db.insert(meals).values(row);
  const meal = (await db.select().from(meals).where(eq(meals.id, row.id)).get())!;
  return { meal, created: true };
}

export async function updateMeal(id: string, patch: Partial<Pick<MealInput, "name" | "mealType" | "calories" | "protein" | "carbs" | "fats" | "fiber" | "notes">>, userId: string | null = null): Promise<MealRow | null> {
  await db.update(meals).set(patch).where(and(eq(meals.id, id), forUser(userId)));
  return (await db.select().from(meals).where(eq(meals.id, id)).get()) ?? null;
}

export async function deleteMeal(id: string, userId: string | null = null): Promise<boolean> {
  const r = await db.delete(meals).where(and(eq(meals.id, id), forUser(userId)));
  return (r as unknown as { changes?: number }).changes !== 0;
}

export async function mealsForDay(day = dayOf(), userId: string | null = null): Promise<MealRow[]> {
  return db.select().from(meals).where(and(eq(meals.day, day), forUser(userId))).orderBy(meals.at);
}

export async function mealsBetween(fromDay: string, toDay: string, userId: string | null = null): Promise<MealRow[]> {
  return db.select().from(meals).where(and(gte(meals.day, fromDay), lt(meals.day, toDay), forUser(userId))).orderBy(desc(meals.at));
}

export interface DayTotals {
  day: string;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber: number;
  meals: number;
}

export async function dailyTotals(days: number, endDay = dayOf(), userId: string | null = null): Promise<DayTotals[]> {
  const end = new Date(endDay + "T12:00:00");
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const fromDay = dayOf(start);
  const rows = await db
    .select({
      day: meals.day,
      calories: sql<number>`sum(${meals.calories})`,
      protein: sql<number>`sum(${meals.protein})`,
      carbs: sql<number>`sum(${meals.carbs})`,
      fats: sql<number>`sum(${meals.fats})`,
      fiber: sql<number>`sum(${meals.fiber})`,
      meals: sql<number>`count(*)`,
    })
    .from(meals)
    .where(and(gte(meals.day, fromDay), lt(meals.day, dayOf(new Date(end.getTime() + 86_400_000))), forUser(userId)))
    .groupBy(meals.day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DayTotals[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = dayOf(d);
    const r = byDay.get(k);
    out.push(r ? { day: k, calories: Math.round(r.calories), protein: Math.round(r.protein), carbs: Math.round(r.carbs), fats: Math.round(r.fats), fiber: Math.round(r.fiber), meals: r.meals } : { day: k, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, meals: 0 });
  }
  return out;
}

/** Consecutive days ending today (or yesterday, if today has nothing yet) with ≥1 meal logged. */
export async function streakDays(userId: string | null = null): Promise<number> {
  const hist = await dailyTotals(60, dayOf(), userId);
  let i = hist.length - 1;
  if (hist[i]?.meals === 0) i -= 1; // today not logged yet does not break the streak
  let n = 0;
  for (; i >= 0 && (hist[i]?.meals ?? 0) > 0; i--) n++;
  return n;
}

// ---------------------------------------------------------------- coach log

export async function lastCoachMessage(): Promise<{ at: number; kind: string; message: string } | null> {
  const r = await db.select().from(coachMessages).orderBy(desc(coachMessages.at)).limit(1).get();
  return r ? { at: r.at.getTime(), kind: r.kind, message: r.message } : null;
}

export async function recordCoachMessage(kind: string, message: string, reasoning: string): Promise<void> {
  const at = Date.now();
  await db.insert(coachMessages).values({ id: randomUUID(), at: new Date(at), day: dayOf(at), kind, message, reasoning });
}

export async function coachHistory(limit = 20) {
  return db.select().from(coachMessages).orderBy(desc(coachMessages.at)).limit(limit);
}
