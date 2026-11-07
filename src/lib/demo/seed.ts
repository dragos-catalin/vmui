import "server-only";

import { createUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLog, users } from "@/lib/db/schema";
import { upsertMember } from "@/lib/home/family";
import { importFromHomeAssistant } from "@/lib/home/ha-import";
import { saveHousehold } from "@/lib/household";
import { notify } from "@/lib/notify";
import { addMeal, dayOf } from "@/lib/nutrition/store";
import { addWater } from "@/lib/nutrition/water";
import { burnSetupCode } from "@/lib/setup-code";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DEMO_REVIEWER_EMAIL } from "./invite";

// Seeds a fresh demo database (P10-04). Imported by reset.ts only AFTER the old files are gone,
// because importing it opens the database. Idempotent: a second call finds the reviewer and stops.

export type DemoSeed = { userId: string; created: boolean; rooms: number; devices: number };

export async function seedDemo(): Promise<DemoSeed> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_REVIEWER_EMAIL)).get();
  if (existing) return { userId: existing.id, created: false, rooms: 0, devices: 0 };

  const password = process.env.VATRA_DEMO_REVIEW_PASSWORD ?? "";
  if (password.length < 8) console.warn("[vatra-demo] VATRA_DEMO_REVIEW_PASSWORD missing or shorter than 8: reviewer sign-in is disabled");
  const user = await createUser({
    email: DEMO_REVIEWER_EMAIL,
    displayName: "App Review",
    password: password.length >= 8 ? password : randomBytes(24).toString("base64url"),
    role: "admin",
  });
  // claimed: the setup code is useless from now on (same as the first sign-up)
  burnSetupCode();
  await upsertMember({ userId: user.id, role: "owner", rooms: {}, expiresAt: null }, "demo-seed");

  saveHousehold({ timeZone: "Europe/Bucharest", locale: "en", ownerPerson: "person.alex", publicUrl: (process.env.VATRA_PUBLIC_URL ?? "").replace(/\/$/, "") });
  const plan = await importFromHomeAssistant();

  const now = Date.now();
  const day = dayOf(now);
  const at = (h: number) => {
    // today's hour in Bucharest-ish time, clamped to the past so the journal never shows the future
    const t = new Date(`${day}T${String(h).padStart(2, "0")}:00:00+02:00`).getTime();
    return Math.min(t, now - 60_000);
  };
  await addMeal({ name: "Oatmeal with berries", mealType: "breakfast", calories: 380, protein: 12, carbs: 62, fats: 9, fiber: 8, at: at(8), items: [], confidence: 0.85, notes: "", source: "demo", syncedToHealthConnect: false, userId: user.id });
  await addMeal({ name: "Chicken salad", mealType: "lunch", calories: 540, protein: 38, carbs: 24, fats: 30, fiber: 7, at: at(13), items: [], confidence: 0.8, notes: "", source: "demo", syncedToHealthConnect: false, userId: user.id });
  for (const h of [8, 10, 12, 15]) await addWater(250, "demo", at(h), user.id);

  await notify({ kind: "system", tag: "demo-welcome", title: "Welcome to the Vatra demo", body: "A simulated home: lights, air conditioning, the front door and the intercom all respond. Changes reset every night.", priority: "default", noFallback: true });
  await notify({ kind: "door", tag: "demo-door", title: "Front door locked", body: "Locked at 22:14 by Alex.", priority: "low", noFallback: true });
  await notify({ kind: "water", tag: "demo-water", title: "Time for a glass of water", body: "1 L of 2.4 L today.", priority: "default", noFallback: true });

  await db.insert(auditLog).values({ accountId: "home", action: "demo.seed", target: DEMO_REVIEWER_EMAIL, status: "ok", message: `${plan.rooms.length} rooms, ${plan.devices.length} devices` });
  return { userId: user.id, created: true, rooms: plan.rooms.length, devices: plan.devices.length };
}
