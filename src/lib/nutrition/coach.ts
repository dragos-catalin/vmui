import "server-only";

import { hasAiConsent } from "@/lib/ai/consent";
import { journalUserId, ownerActor } from "@/lib/home/access";
import { credential } from "@/lib/home/credentials";
import { msg, type Text } from "@/lib/notify/i18n";
import { loadProfile, recordCoachMessage } from "./store";
import type { NutritionSummary } from "./summary";

/** The coach is mancai's `coach-evaluation.ts` made deterministic: the RULES
 *  decide whether and what kind of message goes out (so it is testable and
 *  never spams), and the LLM — when a codai key exists — only writes the
 *  sentence. Without a key the canned line (messages/notify cards.coach.fallback)
 *  is used. Max one push per day, only inside the profile's coach window. */

export type CoachKind = "streak_risk" | "over_target" | "under_target" | "protein_low" | "celebration" | "weekly_review" | "no_data";

export interface CoachDecision {
  kind: CoachKind;
  priority: "low" | "medium" | "high";
  /** Canned text used when no LLM is configured (message ref, rendered per consumer). */
  fallback: Text;
  /** Facts for the LLM to phrase. */
  facts: string;
}

export function decide(s: NutritionSummary, now = new Date()): CoachDecision | null {
  const hour = now.getHours();
  const dow = now.getDay(); // 0 = Sunday
  const t = s.targets;
  const daysWithData = s.week.filter((d) => d.meals > 0);
  const last5 = s.week.slice(-6, -1); // yesterday back 5 days
  const over = last5.filter((d) => d.meals > 0 && d.calories > t.calories * 1.15).length;
  const under = last5.filter((d) => d.meals > 0 && d.calories < t.calories * 0.7).length;
  const onTarget = last5.filter((d) => d.meals > 0 && Math.abs(d.calories - t.calories) <= t.calories * 0.1).length;

  if (daysWithData.length < 2) return null; // too new to say anything useful

  if (s.streak >= 3 && s.today.meals === 0 && hour >= 19)
    return { kind: "streak_risk", priority: "high", fallback: msg("cards.coach.fallback.streak_risk", { days: s.streak }), facts: `streak ${s.streak} days, 0 meals today, hour ${hour}` };

  if (dow === 0 && hour >= 18 && daysWithData.length >= 5) {
    const avg = Math.round(daysWithData.reduce((a, d) => a + d.calories, 0) / daysWithData.length);
    return { kind: "weekly_review", priority: "low", fallback: msg("cards.coach.fallback.weekly_review", { days: daysWithData.length, avg, target: t.calories, onTarget: onTarget >= 4 ? 2 : 0 }), facts: `days with data ${daysWithData.length}/7, average ${avg} kcal, target ${t.calories}, days on target ${onTarget}` };
  }

  if (over >= 4) return { kind: "over_target", priority: "medium", fallback: msg("cards.coach.fallback.over_target", { delta: Math.round(last5.reduce((a, d) => a + d.calories, 0) / 5 - t.calories) }), facts: `${over}/5 days more than 15 % over target` };
  if (under >= 4) return { kind: "under_target", priority: "medium", fallback: msg("cards.coach.fallback.under_target"), facts: `${under}/5 days under 70 % of target` };

  if (s.today.meals >= 2 && s.today.protein < t.protein * 0.4 && hour >= 16)
    return { kind: "protein_low", priority: "low", fallback: msg("cards.coach.fallback.protein_low", { protein: s.today.protein, target: t.protein }), facts: `protein ${s.today.protein}/${t.protein} g at hour ${hour}` };

  if (onTarget >= 5) return { kind: "celebration", priority: "low", fallback: msg("cards.coach.fallback.celebration"), facts: `${onTarget} consecutive days within ±10 % of target` };

  return null;
}

function inWindow(from: string, to: string, now = new Date()): boolean {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= (fh ?? 0) * 60 + (fm ?? 0) && cur <= (th ?? 23) * 60 + (tm ?? 59);
}

/** One sentence from codai in the household language; falls back to the canned message ref. */
async function phrase(d: CoachDecision, s: NutritionSummary, language: string, aiAllowed: boolean): Promise<Text> {
  const key = credential("CODAI_API_KEY");
  if (!key || !aiAllowed) return d.fallback;
  try {
    const r = await fetch("https://ai.codai.ro/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        model: "codai-fast",
        temperature: 0.7,
        max_tokens: 120,
        messages: [
          { role: "system", content: `You are a warm, concise nutrition coach. Write ONE notification of 1-2 sentences in the language with ISO code "${language}", addressing the reader informally in the second person, no medical advice, at most one emoji. Reply with the notification text only.` },
          { role: "user", content: `Kind: ${d.kind}. Facts: ${d.facts}. Daily target ${s.targets.calories} kcal, today ${s.today.calories} kcal in ${s.today.meals} meals, streak ${s.streak} days.` },
        ],
      }),
    });
    if (!r.ok) return d.fallback;
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const txt = j.choices?.[0]?.message?.content?.trim();
    return txt && txt.length > 10 && txt.length < 300 ? txt : d.fallback;
  } catch {
    return d.fallback;
  }
}

/** Run once per poll; sends at most one notification per day. Household-level:
 *  `s` must be the owner's summary and the window comes from the owner's profile. */
export async function runCoach(s: NutritionSummary, now = new Date()): Promise<{ sent: boolean; kind?: CoachKind; reason: string }> {
  const o = await ownerActor();
  const p = await loadProfile(o ? journalUserId(o) : null, true);
  if (!p.coachEnabled) return { sent: false, reason: "disabled" };
  if (!inWindow(p.coachFrom, p.coachTo, now)) return { sent: false, reason: "outside window" };
  if (s.coach && now.getTime() - s.coach.at < 24 * 3600_000) return { sent: false, reason: "sent in last 24 h" };
  const d = decide(s, now);
  if (!d) return { sent: false, reason: "nothing worth saying" };
  const [{ notify }, { render }, { loadNotifySettings }] = await Promise.all([import("@/lib/notify"), import("@/lib/notify/i18n"), import("@/lib/notify/settings")]);
  const { language } = await loadNotifySettings();
  // the facts leave the hub only after the owner accepted the AI disclosure (/ai, docs/legal/AI-DISCLOSURE.md)
  const text = await phrase(d, s, language, await hasAiConsent(o?.userId).catch(() => false));
  // the journal keeps one rendered line (the household language); the card itself stays language-neutral
  await recordCoachMessage(d.kind, await render(text, language), d.facts);
  await notify({
    kind: "water",
    tag: "nutrition-coach",
    title: msg(`cards.coach.title.${d.kind}`),
    body: text,
    priority: d.priority === "high" ? "high" : "default",
    color: "#10b981",
    icon: "apple",
    ttlSec: 6 * 3600,
    data: { coach: d.kind },
  }).catch(() => undefined);
  return { sent: true, kind: d.kind, reason: d.facts };
}
