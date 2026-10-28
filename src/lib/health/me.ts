import "server-only";
import { deviceHomeActor, type HomeActor } from "@/lib/home/access";
import { ha, type HaState } from "@/lib/home/ha-client";
import { nutritionSummary, type NutritionSummary } from "@/lib/nutrition/summary";
import { healthReadings, type HealthReadings } from "@/lib/turzx/feeds";
import { loadTurzxSettings } from "@/lib/turzx/settings";

/**
 * What `GET /api/v1/me/health` returns to a paired Vitals app.
 *
 * Health readings come from Home Assistant (the phone's Health Connect sensors
 * and the scale); every number is `null` when it was not measured, never 0.
 * The response is built per request and never cached or logged: this is
 * special-category personal data (GDPR art. 9) and only its owner may read it.
 */
export interface MeHealth {
  at: number;
  health: HealthReadings | null;
  nutrition: Pick<NutritionSummary, "day" | "targets" | "today" | "remaining" | "balance" | "activeKcal" | "water" | "week"> | null;
}

export type MeHealthResult =
  | { ok: true; body: MeHealth }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Only the household owner's device: the readings are the owner's own body
 * (their phone, their scale), so a member's device must not see them.
 * The token is read from the Authorization header only; `?d=` is refused so
 * a token never lands in a URL, a proxy log or browser history.
 */
export async function authorise(req: Request, actorOf: (r: Request) => Promise<HomeActor | null> = deviceHomeActor): Promise<{ ok: true; actor: HomeActor } | { ok: false; status: 401 | 403; error: string }> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer vmd_")) return { ok: false, status: 401, error: "A paired device token is required" };
  const actor = await actorOf(req);
  if (!actor) return { ok: false, status: 401, error: "Unknown or revoked device token" };
  if (actor.role !== "owner") return { ok: false, status: 403, error: "Only the owner's devices can read health data" };
  return { ok: true, actor };
}

export async function meHealth(req: Request, deps: { actorOf?: (r: Request) => Promise<HomeActor | null> } = {}): Promise<MeHealthResult> {
  const a = await authorise(req, deps.actorOf);
  if (!a.ok) return a;

  let states = new Map<string, HaState>();
  try {
    states = new Map((await ha.states()).map((s) => [s.entity_id, s]));
  } catch {
    // Home Assistant down: health is null, nutrition still answers from the DB.
  }
  const settings = await loadTurzxSettings();
  const opt = settings.views.find((v) => v.id === "health")?.options ?? {};
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

  const [health, summary] = await Promise.all([
    states.size
      ? healthReadings(states, str(opt.device, "dragos_s_s25_ultra"), {
          heightCm: num(opt.heightCm, 173),
          birthDate: str(opt.birthDate, "1993-12-12"),
          sex: str(opt.sex, "m") === "f" ? "f" : "m",
        }).catch(() => null)
      : Promise.resolve(null),
    nutritionSummary(a.actor.userId !== "solo" ? { userId: a.actor.userId, isOwner: true } : null).catch(() => null),
  ]);

  return {
    ok: true,
    body: {
      at: Date.now(),
      health,
      // Meals, coach messages and hydration entries stay in vmui: the
      // monitor shows totals, not a food diary.
      nutrition: summary
        ? { day: summary.day, targets: summary.targets, today: summary.today, remaining: summary.remaining, balance: summary.balance, activeKcal: summary.activeKcal, water: { ...summary.water, entries: [] }, week: summary.week }
        : null,
    },
  };
}
