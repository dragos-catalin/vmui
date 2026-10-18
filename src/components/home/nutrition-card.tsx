"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Subsection } from "@/components/ui/settings-panel";
import { Stat, StatGrid, type StatTone } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { ACTIVITY, GOALS, MEAL_TYPES, type MealType, type NutritionProfile } from "@/lib/nutrition/schema";
import type { NutritionSummary } from "@/lib/nutrition/summary";
import { cn } from "@/lib/utils";
import { addMealAction, addWaterAction, deleteMealAction, saveNutritionProfileAction, undoWaterAction } from "@/server/actions/nutrition";
import { Droplets, Flame, Plus, Salad, Scale, Trash2, TriangleAlert, Undo2, UtensilsCrossed } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { EASE_OUT, SPRING_SOFT } from "./home-motion";
import { useHomeAction } from "./use-home-action";

const GLASS_ML = 250;
const SIP_ML = 100;

const liters = (ml: number) => (ml / 1000).toFixed(2).replace(/\.?0+$/, "");

/** Meal journal + targets. Same data the phone assistant writes via
 *  POST /api/nutrition/meal; this is the desk view and the manual fallback. */
export function NutritionCard({ initial, profile }: { initial: NutritionSummary; profile: NutritionProfile }) {
  const t = useTranslations("nutrition");
  const fmt = useFormatter();
  const s = initial;
  const [busy, setBusy] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ name: "", mealType: "snack" as MealType, calories: "", protein: "", carbs: "", fats: "" });
  const [p, setP] = React.useState<NutritionProfile>(profile);
  const dirty = JSON.stringify(p) !== JSON.stringify(profile);
  const opts = { refresh: true } as const;
  const addMeal = useHomeAction(addMealAction, opts);
  const delMeal = useHomeAction(deleteMealAction, opts);
  const addWater = useHomeAction(addWaterAction, opts);
  const undoWater = useHomeAction(undoWaterAction, { ...opts, success: t("toast.waterUndone") });
  const saveProfileAction = useHomeAction(saveNutritionProfileAction, { ...opts, success: t("toast.profileSaved") });

  const fmtTime = (ms: number) => fmt.dateTime(new Date(ms), { hour: "2-digit", minute: "2-digit" });
  const fmtDay = (day: string) => fmt.dateTime(new Date(day + "T12:00:00"), { weekday: "short" });
  const mealLabel = (type: string) => (MEAL_TYPES.includes(type as MealType) ? t(`mealType.${type as MealType}`) : type);

  const pct = s.targets.calories > 0 ? Math.min(1.2, s.today.calories / s.targets.calories) : 0;
  const over = s.today.calories > s.targets.calories;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.calories) return;
    setBusy("add");
    const name = form.name.trim();
    const r = await addMeal.run({
      name,
      mealType: form.mealType,
      calories: Number(form.calories),
      protein: Number(form.protein || 0),
      carbs: Number(form.carbs || 0),
      fats: Number(form.fats || 0),
      confidence: 1,
    });
    setBusy(null);
    if (r.ok) {
      toast.success(t("toast.mealAdded", { name, kcal: form.calories }));
      setForm({ name: "", mealType: form.mealType, calories: "", protein: "", carbs: "", fats: "" });
    }
  };
  const remove = async (id: string, name: string) => {
    setBusy(id);
    const r = await delMeal.run(id);
    setBusy(null);
    if (r.ok) toast.success(t("toast.mealDeleted", { name }));
  };
  const water = async (ml: number | "undo") => {
    setBusy("water");
    const r = ml === "undo" ? await undoWater.run() : await addWater.run(ml);
    setBusy(null);
    if (r.ok && ml !== "undo") toast.success(t("toast.waterAdded", { ml }));
  };
  const saveProfile = async () => {
    setBusy("profile");
    await saveProfileAction.run(p);
    setBusy(null);
  };

  const tiles: Array<{ key: string; value: string; label: string; hint?: string; tone?: StatTone; icon: React.ReactNode }> = [
    { key: "kcal", value: fmt.number(Math.round(s.today.calories)), label: t("tiles.kcalToday"), hint: t("tiles.kcalOfTarget", { kcal: fmt.number(s.targets.calories) }), icon: <Flame /> },
    {
      key: "remaining",
      value: fmt.number(Math.round(Math.abs(s.remaining.calories))),
      label: over ? t("tiles.over") : t("tiles.remaining"),
      tone: over ? "warning" : "success",
      icon: <UtensilsCrossed />,
    },
    { key: "water", value: t("water.liters", { l: liters(s.water.ml) }), label: t("tiles.water"), hint: t("tiles.waterOfTarget", { l: liters(s.water.targetMl) }), icon: <Droplets /> },
    s.balance !== null
      ? { key: "balance", value: `${s.balance > 0 ? "+" : ""}${fmt.number(Math.round(s.balance))}`, label: t("tiles.balance"), hint: t("tiles.balanceHint"), icon: <Scale /> }
      : { key: "weight", value: t("weight", { kg: s.targets.weightKg.toFixed(1) }), label: t("tiles.weight"), hint: t("tiles.weightHint", { source: t(`weightSource.${s.targets.weightSource === "scale" ? "scale" : "profile"}`) }), icon: <Scale /> },
  ];

  const macros = [
    { key: "protein", label: t("macros.protein"), v: s.today.protein, target: s.targets.protein },
    { key: "carbs", label: t("macros.carbs"), v: s.today.carbs, target: s.targets.carbs },
    { key: "fats", label: t("macros.fats"), v: s.today.fats, target: s.targets.fats },
  ];

  const numericFields = [
    { key: "calories", label: t("addMeal.kcal"), required: true },
    { key: "protein", label: t("addMeal.proteinG"), required: false },
    { key: "carbs", label: t("addMeal.carbsG"), required: false },
    { key: "fats", label: t("addMeal.fatsG"), required: false },
  ] as const;

  return (
    <section className="space-y-4" aria-labelledby="nutrition-h">
      <header className="surface flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-bg-muted)] text-[var(--color-primary)]"><Salad className="size-4.5" aria-hidden /></span>
          <div className="min-w-0">
            <h3 id="nutrition-h" className="text-sm font-semibold">{t("title")}</h3>
            <p className="text-xs leading-snug text-muted">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted">
          <Scale className="size-3.5" aria-hidden />
          <span className="tabular-nums">
            {t("weight", { kg: s.targets.weightKg.toFixed(1) })} <span className="opacity-70">({t(`weightSource.${s.targets.weightSource === "scale" ? "scale" : "profile"}`)})</span>
          </span>
          <Badge variant={s.streak >= 3 ? "success" : "muted"}>{t("streak", { n: s.streak })}</Badge>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="surface min-w-0 space-y-4 p-4 sm:p-5">
          <StatGrid cols={4}>
            {tiles.map((tile, i) => (
              <m.div key={tile.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_OUT, delay: i * 0.035 }} className="min-w-0">
                <Stat label={tile.label} value={tile.value} hint={tile.hint} tone={tile.tone} icon={tile.icon} className="h-full border border-border shadow-none" />
              </m.div>
            ))}
          </StatGrid>
          <Progress value={Math.min(100, pct * 100)} tone={over ? "warning" : "default"} label={t("today.progressAria")} />

          <dl className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3 text-sm" aria-label={t("macros.title")}>
            {macros.map((m) => (
              <div key={m.key} className="min-w-0 rounded-xl border border-border p-3">
                <dt className="truncate text-xs text-muted" title={m.label}>{m.label}</dt>
                <dd className="font-medium tabular-nums">
                  {fmt.number(Math.round(m.v))} <span className="text-xs font-normal text-muted">{t("macros.ofTarget", { g: fmt.number(m.target) })}</span>
                </dd>
                <Progress size="sm" className="mt-2" value={m.target > 0 ? (m.v / m.target) * 100 : 0} />
              </div>
            ))}
          </dl>

          <div className="space-y-3 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Droplets className={cn("size-4 shrink-0", s.water.underPace ? "text-warning-text" : "text-primary-text")} aria-hidden />
                <span className="font-medium tabular-nums">{t("water.liters", { l: liters(s.water.ml) })}</span>
                <span className="text-xs text-muted tabular-nums">{t("water.glasses", { n: s.water.glasses })}</span>
              </span>
              <span className="text-xs text-muted tabular-nums">
                {s.water.lastAt ? t("water.last", { time: fmtTime(s.water.lastAt) }) : t("water.none")}
                {s.water.underPace && <span className="ml-2 text-warning-text">{t("water.underPace")}</span>}
              </span>
            </div>
            <Progress size="sm" value={s.water.ml} max={Math.max(1, s.water.targetMl)} tone={s.water.underPace ? "warning" : "default"} label={t("water.progressAria")} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" loading={busy === "water"} onClick={() => water(GLASS_ML)} aria-label={t("water.addAria", { ml: GLASS_ML })}>
                <Plus className="size-3.5" aria-hidden /> {t("water.add", { ml: GLASS_ML })}
              </Button>
              <Button size="sm" variant="outline" disabled={busy === "water"} onClick={() => water(SIP_ML)} aria-label={t("water.addAria", { ml: SIP_ML })}>
                <Plus className="size-3.5" aria-hidden /> {t("water.add", { ml: SIP_ML })}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === "water" || s.water.glasses === 0} onClick={() => water("undo")} aria-label={t("water.undoAria")}>
                <Undo2 className="size-3.5" aria-hidden /> {t("water.undo")}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">{t("meals.title")}</p>
            {s.meals.length === 0 ? (
              <EmptyState compact icon={<UtensilsCrossed />} title={t("meals.empty")} />
            ) : (
            <ul className="divide-y divide-border" aria-label={t("meals.listAria")}>
              <AnimatePresence initial={false}>
              {s.meals.map((meal, i) => (
                <m.li key={meal.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: EASE_OUT, delay: Math.min(i, 8) * 0.035 }} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-12 shrink-0 text-xs tabular-nums text-muted">{fmtTime(meal.at)}</span>
                  <span className="min-w-0 flex-1 truncate" title={`${meal.name} · ${mealLabel(meal.mealType)}`}>
                    {meal.name}
                    <span className="ml-2 text-xs text-muted">{mealLabel(meal.mealType)}</span>
                    {meal.confidence < 0.5 && <span className="ml-2 text-xs text-warning-text">{t("meals.approx")}</span>}
                    {meal.source !== "web" && <span className="ml-2 text-xs text-muted">· {meal.source}</span>}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{t("meals.kcal", { kcal: fmt.number(Math.round(meal.calories)) })}</span>
                  <span className="hidden min-w-24 shrink-0 text-right text-xs tabular-nums text-muted sm:inline">{t("meals.macrosShort", { p: Math.round(meal.protein), c: Math.round(meal.carbs), f: Math.round(meal.fats) })}</span>
                  <Button variant="ghost" size="icon" aria-label={t("meals.deleteAria", { name: meal.name })} loading={busy === meal.id} onClick={() => void remove(meal.id, meal.name)}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </m.li>
              ))}
              </AnimatePresence>
            </ul>
            )}
          </div>

          <Subsection title={t("addMeal.title")} hint={t("addMeal.hint")}>
            <form onSubmit={add} className="space-y-3" aria-label={t("addMeal.formAria")}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)]">
                <Field label={t("addMeal.name")}>
                  <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("addMeal.namePlaceholder")} />
                </Field>
                <Field label={t("addMeal.type")}>
                  <Select value={form.mealType} onValueChange={(v) => setForm({ ...form, mealType: v as MealType })}>
                    <SelectTrigger aria-label={t("addMeal.type")}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MEAL_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>{t(`mealType.${type}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {numericFields.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Input type="number" inputMode="numeric" min={0} required={f.required} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className="min-w-0 px-2" />
                  </Field>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy === "add"}>
                  <Plus className="size-4" aria-hidden /> {t("addMeal.submit")}
                </Button>
              </div>
            </form>
          </Subsection>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="surface p-4 sm:p-5">
            <p className="mb-3 text-sm font-semibold">{t("week.title")}</p>
            <div className="flex h-24 items-end gap-1.5" role="img" aria-label={t("week.chartAria", { list: s.week.map((d) => `${fmtDay(d.day)} ${Math.round(d.calories)}`).join(", ") })}>
              {s.week.map((d) => {
                const h = s.targets.calories > 0 ? Math.min(1, d.calories / (s.targets.calories * 1.2)) : 0;
                const o = d.calories > s.targets.calories;
                const title = t("week.barTitle", { kcal: fmt.number(Math.round(d.calories)), n: d.meals });
                return (
                  <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <div className="relative flex w-full flex-1 items-end">
                      {/* over target: hatched bar + warning icon, not colour alone */}
                      {o && <TriangleAlert className="absolute -top-0.5 left-1/2 size-3 -translate-x-1/2 text-warning-text" aria-hidden />}
                      <m.div
                        className={cn(
                          "w-full rounded-t",
                          o ? "bg-warning bg-[repeating-linear-gradient(135deg,transparent_0_3px,color-mix(in_oklch,var(--color-fg)_22%,transparent)_3px_5px)]" : d.meals ? "bg-primary" : "bg-[color-mix(in_oklch,var(--color-fg)_12%,transparent)]",
                        )}
                        initial={{ height: "4%" }}
                        animate={{ height: `${Math.max(4, h * 100)}%` }}
                        transition={SPRING_SOFT}
                        title={title}
                      />
                    </div>
                    <span className="max-w-full truncate text-xs text-muted">{fmtDay(d.day)}</span>
                  </div>
                );
              })}
            </div>
            {s.coach && (
              <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
                <UtensilsCrossed className="mr-1 inline size-3" aria-hidden />
                {s.coach.message}
              </p>
            )}
          </div>

          <div className="surface space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-semibold">{t("profile.title")}</p>
              <span className="text-xs text-muted tabular-nums">{t("profile.bmrTdee", { bmr: fmt.number(s.targets.bmr), tdee: fmt.number(s.targets.tdee) })}</span>
            </div>

            <Subsection title={t("profile.targets.title")} hint={t("profile.targets.hint")}>
              <div className="grid grid-cols-2 items-start gap-3">
                <Field label={t("profile.goal")}>
                  <Select value={p.goal} onValueChange={(v) => setP({ ...p, goal: v as NutritionProfile["goal"] })}>
                    <SelectTrigger aria-label={t("profile.goal")}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GOALS.map((g) => (
                        <SelectItem key={g} value={g}>{t(`goal.${g}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("profile.activity")}>
                  <Select value={p.activity} onValueChange={(v) => setP({ ...p, activity: v as NutritionProfile["activity"] })}>
                    <SelectTrigger aria-label={t("profile.activity")}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ACTIVITY.map((a) => (
                        <SelectItem key={a} value={a}>{t(`activity.${a}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("profile.targetOverride")} hint={t("profile.targetOverrideHint")} className="col-span-2">
                  <Input type="number" inputMode="numeric" min={800} max={6000} value={p.targetCaloriesOverride ?? ""} onChange={(e) => setP({ ...p, targetCaloriesOverride: e.target.value ? Number(e.target.value) : null })} />
                </Field>
              </div>
            </Subsection>

            <Subsection title={t("profile.body.title")} hint={t("profile.body.hint")}>
              <div className="grid grid-cols-2 items-start gap-3">
                <Field label={t("profile.heightCm")}>
                  <Input type="number" inputMode="numeric" min={100} max={230} value={p.heightCm} onChange={(e) => setP({ ...p, heightCm: Number(e.target.value) })} />
                </Field>
                <Field label={t("profile.birthDate")}>
                  <Input type="date" value={p.birthDate} onChange={(e) => setP({ ...p, birthDate: e.target.value })} />
                </Field>
                <Field label={t("profile.weightFallback")} hint={t("profile.weightFallbackHint")} className="col-span-2">
                  <Input type="number" inputMode="decimal" min={30} max={300} step={0.1} value={p.weightKgFallback} onChange={(e) => setP({ ...p, weightKgFallback: Number(e.target.value) })} />
                </Field>
              </div>
            </Subsection>

            <Subsection title={t("profile.coach.title")} hint={t("profile.coach.hint")}>
              <Field
                inline
                label={
                  <span className="flex items-center gap-2">
                    <Flame className="size-3.5 shrink-0" aria-hidden />
                    {t("profile.coachEnabled")}
                  </span>
                }
                hint={t("profile.coachWindow", { from: p.coachFrom, to: p.coachTo })}
              >
                <Switch checked={p.coachEnabled} onCheckedChange={(v) => setP({ ...p, coachEnabled: v })} aria-label={t("profile.coachEnabled")} />
              </Field>
            </Subsection>

            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" disabled={!dirty} loading={busy === "profile"} onClick={saveProfile}>{t("profile.save")}</Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
