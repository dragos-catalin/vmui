"use server";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { journalUserId, requireHomeActor, type HomeActor } from "@/lib/home/access";
import { setNutritionEvent } from "@/lib/nutrition/events";
import { mealInputSchema, nutritionProfileSchema, type NutritionProfile } from "@/lib/nutrition/schema";
import { addMeal, deleteMeal, saveProfile, updateMeal } from "@/lib/nutrition/store";
import { nutritionSummary, publishToHa } from "@/lib/nutrition/summary";
import { deleteWater } from "@/lib/nutrition/water";
import { drinkGlass, undoGlass } from "@/lib/nutrition/water-actions";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

type Result = { ok: true } | { ok: false; error: string };

type Scope = { actor: HomeActor; uid: string | null; isOwner: boolean };

async function run(action: string, target: string, message: string, fn: (s: Scope) => Promise<unknown>): Promise<Result> {
  let scope: Scope;
  try {
    const actor = await requireHomeActor();
    scope = { actor, uid: journalUserId(actor), isOwner: actor.role === "owner" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not authorized" };
  }
  const by = scope.actor.email ? ` by ${scope.actor.email}` : "";
  try {
    await fn(scope);
    await db.insert(auditLog).values({ accountId: "home", action, target, status: "ok", message: `${message}${by}` });
    revalidatePath("/home");
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action, target, status: "error", message: `${error}${by}` });
    return { ok: false, error };
  }
}

/** HA sensors mirror the household owner's journal only. */
async function republish({ uid, isOwner }: Scope): Promise<void> {
  if (!isOwner) return;
  const s = await nutritionSummary(uid ? { userId: uid, isOwner } : null);
  await publishToHa(s).catch(() => undefined);
}

export async function addMealAction(raw: unknown): Promise<Result> {
  const parsed = mealInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid meal" };
  const input = { ...parsed.data, source: "web" };
  return run("nutrition.meal.add", input.name, `${input.calories} kcal`, async (s) => {
    const { meal } = await addMeal({ ...input, userId: s.uid });
    if (s.isOwner) setNutritionEvent({ kind: "meal", at: Date.now(), name: meal.name, calories: meal.calories, mealType: meal.mealType });
    await republish(s);
  });
}

const patchSchema = mealInputSchema.pick({ name: true, mealType: true, calories: true, protein: true, carbs: true, fats: true, fiber: true, notes: true }).partial();

export async function updateMealAction(id: string, raw: unknown): Promise<Result> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid patch" };
  return run("nutrition.meal.update", id, JSON.stringify(parsed.data).slice(0, 200), async (s) => {
    if (!(await updateMeal(id, parsed.data, s.uid))) throw new Error("Meal not found");
    await republish(s);
  });
}

export async function deleteMealAction(id: string): Promise<Result> {
  return run("nutrition.meal.delete", id, "deleted", async (s) => {
    if (!(await deleteMeal(z.string().min(1).parse(id), s.uid))) throw new Error("Meal not found");
    await republish(s);
  });
}

export async function saveNutritionProfileAction(raw: unknown): Promise<Result> {
  const parsed = nutritionProfileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid profile" };
  const p: NutritionProfile = parsed.data;
  return run("nutrition.profile.save", "profile", `${p.goal} · ${p.activity} · ${p.heightCm} cm`, async (s) => {
    await saveProfile(p, s.uid);
    await republish(s);
  });
}

export async function addWaterAction(ml = 250): Promise<Result> {
  const v = z.number().int().min(25).max(2000).safeParse(ml);
  if (!v.success) return { ok: false, error: (await getTranslations("nutrition"))("water.invalidAmount") };
  // drinkGlass audits itself; run() only guards + revalidates.
  return run("nutrition.water.web", "water", `${v.data} ml`, (s) => drinkGlass(v.data, "web", s.uid, s.isOwner));
}

export async function undoWaterAction(): Promise<Result> {
  return run("nutrition.water.web", "water", "undo", (s) => undoGlass("web", s.uid, s.isOwner));
}

export async function deleteWaterAction(id: string): Promise<Result> {
  return run("nutrition.water.delete", id, "deleted", async (s) => {
    if (!(await deleteWater(z.string().min(1).parse(id), s.uid))) throw new Error("Not found");
    await republish(s);
  });
}
