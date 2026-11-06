import { espAuthorized } from "@/lib/esp/auth";
import { homeActorOrOwner, journalUserId } from "@/lib/home/access";
import { runCoach } from "@/lib/nutrition/coach";
import { household } from "@/lib/household";
import { MEAL_ANALYSIS_JSON_SCHEMA, mealAnalysisSystemPrompt, nutritionProfileSchema } from "@/lib/nutrition/schema";
import { loadProfile, saveProfile } from "@/lib/nutrition/store";
import { nutritionSummary, publishToHa } from "@/lib/nutrition/summary";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

async function scoped(req: NextRequest) {
  const actor = await homeActorOrOwner(req, espAuthorized(req));
  if (!actor) return null;
  const uid = journalUserId(actor);
  const isOwner = actor.role === "owner";
  return { uid, isOwner, scope: uid ? { userId: uid, isOwner } : null };
}

// GET  /api/nutrition/today?k=TOKEN[&coach=1][&publish=1]
//      The phone assistant reads this before an analysis so it can say "you
//      have 640 kcal left today". `coach=1` also runs the coach rules (turzx
//      poller does this once per poll; it is cheap and self-limits to 1/day).
// GET  /api/nutrition/today?k=TOKEN&contract=1  -> prompt + json_schema for the phone
// PUT  /api/nutrition/today?k=TOKEN  body: NutritionProfile  (profile/targets)
export async function GET(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const sp = req.nextUrl.searchParams;
  if (sp.get("contract")) {
    return NextResponse.json({ systemPrompt: mealAnalysisSystemPrompt(household().locale), locale: household().locale, responseFormat: { type: "json_schema", json_schema: MEAL_ANALYSIS_JSON_SCHEMA }, postTo: "/api/nutrition/meal", profile: await loadProfile(a.uid, a.isOwner) });
  }
  const s = await nutritionSummary(a.scope);
  // The coach and the HA mirror are household-level: owner only.
  const coach = sp.get("coach") && a.isOwner ? await runCoach(s) : null;
  if (sp.get("publish") && a.isOwner) await publishToHa(s);
  return NextResponse.json({ ...s, coachRun: coach, profile: await loadProfile(a.uid, a.isOwner) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const a = await scoped(req);
  if (!a) return new NextResponse("unauthorized", { status: 401 });
  const parsed = nutritionProfileSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  await saveProfile(parsed.data, a.uid);
  const s = await nutritionSummary(a.scope);
  if (a.isOwner) void publishToHa(s);
  return NextResponse.json({ profile: parsed.data, targets: s.targets });
}
