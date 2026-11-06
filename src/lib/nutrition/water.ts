import "server-only";

import { db } from "@/lib/db";
import { hydration, type HydrationRow } from "@/lib/db/schema";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { dayOf } from "./store";
import { householdTimeZone } from "@/lib/household";

export const GLASS_ML = 250;
const tz = () => householdTimeZone();
/** Waking hours during which "no water for 2 h" counts as falling behind. */
const PACE_FROM_H = 8;
const PACE_TO_H = 22;
const PACE_GAP_MS = 2 * 3600_000;

export interface WaterSummary {
  day: string;
  ml: number;
  glasses: number;
  targetMl: number;
  /** ml still to drink; 0 once the target is met. */
  remainingMl: number;
  lastAt: number | null;
  /** True during waking hours when the last glass is > 2 h ago and the target is not met. */
  underPace: boolean;
  /** Recent glasses (today), newest first, for the undo list. */
  entries: Array<Pick<HydrationRow, "id" | "ml" | "source"> & { at: number }>;
  week: Array<{ day: string; ml: number }>;
}

/** 35 ml/kg (EFSA adequate intake sits at 2.0-2.5 L for adults, which is
 *  what this gives at 60-70 kg) plus 500 ml on days with real exertion. */
export function waterTargetMl(weightKg: number, activeKcal: number | null): number {
  const base = Math.round((weightKg * 35) / 50) * 50;
  return base + (activeKcal !== null && activeKcal > 500 ? 500 : 0);
}

export async function addWater(ml = GLASS_ML, source = "web", at = Date.now(), userId: string | null = null): Promise<HydrationRow> {
  const row: HydrationRow = { id: randomUUID(), at: new Date(at), day: dayOf(at), ml, source, userId };
  await db.insert(hydration).values(row);
  return row;
}

/** Journal scope: a member sees only their rows; `null` (single-user install) sees everything. */
const forUser = (userId: string | null) => (userId === null ? undefined : eq(hydration.userId, userId));

/** Removes the newest glass of the day. Returns it, or null when there is nothing to undo. */
export async function undoWater(day = dayOf(), userId: string | null = null): Promise<HydrationRow | null> {
  const last = await db.select().from(hydration).where(and(eq(hydration.day, day), forUser(userId))).orderBy(desc(hydration.at)).limit(1).get();
  if (!last) return null;
  await db.delete(hydration).where(eq(hydration.id, last.id));
  return last;
}

export async function deleteWater(id: string, userId: string | null = null): Promise<boolean> {
  const r = await db.delete(hydration).where(and(eq(hydration.id, id), forUser(userId))).returning({ id: hydration.id });
  return r.length > 0;
}

function hourIn(tz: string, at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at));
}

export async function waterSummary(weightKg: number, activeKcal: number | null, now = new Date(), userId: string | null = null): Promise<WaterSummary> {
  const day = dayOf(now);
  const entries = await db.select().from(hydration).where(and(eq(hydration.day, day), forUser(userId))).orderBy(desc(hydration.at));
  const ml = entries.reduce((a, e) => a + e.ml, 0);
  const targetMl = waterTargetMl(weightKg, activeKcal);
  const lastAt = entries[0]?.at.getTime() ?? null;
  const h = hourIn(tz(), now);
  const awake = h >= PACE_FROM_H && h < PACE_TO_H;
  // Before the first glass, "last" is the start of the waking window so a dry
  // morning starts pulsing at 10:00, not never.
  const ref = lastAt ?? (awake ? new Date(now).setHours(PACE_FROM_H, 0, 0, 0) : now.getTime());
  const underPace = awake && ml < targetMl && now.getTime() - ref > PACE_GAP_MS;

  const end = new Date(day + "T12:00:00");
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const fromDay = dayOf(start);
  const next = new Date(end);
  next.setDate(next.getDate() + 1);
  const rows = await db
    .select({ day: hydration.day, ml: sql<number>`sum(${hydration.ml})` })
    .from(hydration)
    .where(and(gte(hydration.day, fromDay), lt(hydration.day, dayOf(next)), forUser(userId)))
    .groupBy(hydration.day);
  const byDay = new Map(rows.map((r) => [r.day, Number(r.ml)]));
  const week: WaterSummary["week"] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = dayOf(d);
    week.push({ day: k, ml: byDay.get(k) ?? 0 });
  }

  return {
    day,
    ml,
    glasses: entries.length,
    targetMl,
    remainingMl: Math.max(0, targetMl - ml),
    lastAt,
    underPace,
    entries: entries.slice(0, 12).map((e) => ({ id: e.id, ml: e.ml, source: e.source, at: e.at.getTime() })),
    week,
  };
}
