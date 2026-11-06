import { db } from "@/lib/db";
import { deviceText } from "@/lib/home/device-text";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { espAuthorized } from "@/lib/esp/auth";
import { homeActorOrOwner, journalUserId } from "@/lib/home/access";
import { setNutritionEvent } from "@/lib/nutrition/events";
import { mealInputSchema } from "@/lib/nutrition/schema";
import { addMeal, deleteMeal, mealsForDay, updateMeal } from "@/lib/nutrition/store";
import { nutritionSummary, publishToHa } from "@/lib/nutrition/summary";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// POST   /api/nutrition/meal?k=TOKEN   body: MealInput (see lib/nutrition/schema.ts)
// GET    /api/nutrition/meal?k=TOKEN[&day=YYYY-MM-DD]
// PATCH  /api/nutrition/meal?k=TOKEN   body: { id, ...fields }
// DELETE /api/nutrition/meal?k=TOKEN&id=…
//
// The codai phone assistant is the main writer (photo -> analysis -> user
// confirms -> POST here + NutritionRecord to Health Connect). Same token as
// the ESP/turzx endpoints; LAN/tailnet only. A bound device token or a browser
// session scopes the journal to that member; the shared token acts as the owner.

async function scoped(req: NextRequest) {
  const actor = await homeActorOrOwner(req, espAuthorized(req));
  if (!actor) return null;
  const uid = journalUserId(actor);
  const isOwner = actor.role === "owner";
  return { uid, isOwner, scope: uid ? { userId: uid, isOwner } : null };
}

const publish = (isOwner: boolean, s: Awaited<ReturnType<typeof nutritionSummary>>) => (isOwner ? publishToHa(s) : Promise.resolve());

export async function POST(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const parsed = mealInputSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  const { meal, created } = await addMeal({ ...parsed.data, userId: a.uid });
  if (created) {
    if (a.isOwner) {
      setNutritionEvent({ kind: "meal", at: Date.now(), name: meal.name, calories: meal.calories, mealType: meal.mealType });
      pushActivity({ at: Date.now(), kind: "other", text: deviceText().meal(meal.name, Math.round(meal.calories)) });
    }
    await db.insert(auditLog).values({ accountId: "home", action: "nutrition.meal.add", target: meal.source, status: "ok", message: `${meal.name} ${Math.round(meal.calories)} kcal` });
  }
  const summary = await nutritionSummary(a.scope);
  void publish(a.isOwner, summary);
  return NextResponse.json({ meal, created, today: summary.today, remaining: summary.remaining, targets: summary.targets }, { status: created ? 201 : 200 });
}

export async function GET(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const day = req.nextUrl.searchParams.get("day") ?? undefined;
  return NextResponse.json({ meals: await mealsForDay(day, a.uid) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string } & Record<string, unknown>;
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch = mealInputSchema.partial().pick({ name: true, mealType: true, calories: true, protein: true, carbs: true, fats: true, fiber: true, notes: true }).safeParse(body);
  if (!patch.success) return NextResponse.json({ error: z.flattenError(patch.error) }, { status: 400 });
  const meal = await updateMeal(body.id, patch.data, a.uid);
  if (!meal) return new NextResponse("not found", { status: 404 });
  await db.insert(auditLog).values({ accountId: "home", action: "nutrition.meal.update", target: meal.id, status: "ok", message: meal.name });
  void nutritionSummary(a.scope).then((s) => publish(a.isOwner, s));
  return NextResponse.json({ meal });
}

export async function DELETE(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteMeal(id, a.uid);
  if (ok) await db.insert(auditLog).values({ accountId: "home", action: "nutrition.meal.delete", target: id, status: "ok", message: "" });
  void nutritionSummary(a.scope).then((s) => publish(a.isOwner, s));
  return NextResponse.json({ deleted: ok });
}
