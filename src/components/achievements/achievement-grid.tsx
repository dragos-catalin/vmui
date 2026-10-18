"use client";

import { Badge, PageSection, Progress } from "@/components/ui";
import type { Achievement } from "@/lib/achievements";
import { cn } from "@/lib/utils";
import { Archive, Award, Bot, Boxes, Camera, Flame, Globe, Rocket, RotateCcw, type LucideIcon } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";

const ICONS: Record<string, LucideIcon> = { Rocket, Boxes, Camera, Archive, RotateCcw, Globe, Bot, Award, Flame };

type ItemKey = "first-vm" | "fleet-builder" | "snap-happy" | "backup-believer" | "restore-hero" | "polyglot" | "ai-curious" | "centurion" | "streak-7" | "streak-30";

export function AchievementGrid({ achievements }: { achievements: Achievement[] }) {
  const t = useTranslations("govern.achievements");
  const next = achievements.filter((a) => !a.unlocked).sort((a, b) => b.progress / b.goal - a.progress / a.goal)[0];

  return (
    <div className="space-y-4">
      {next && (
        <PageSection title={t("next.title")} description={t("next.description")}>
          <AchievementCard a={next} index={0} featured />
        </PageSection>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {achievements.map((a, i) => (
          <li key={a.id}>
            <AchievementCard a={a} index={i} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AchievementCard({ a, index, featured = false }: { a: Achievement; index: number; featured?: boolean }) {
  const t = useTranslations("govern.achievements");
  const Icon = ICONS[a.icon] ?? Award;
  const pct = Math.round((a.progress / a.goal) * 100);
  const key = a.id as ItemKey;

  return (
    <m.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.03 }}
      className={cn(
        "card-hover flex h-full gap-3 rounded-[var(--radius-lg)] border p-4",
        a.unlocked
          ? "border-[color-mix(in_oklch,var(--color-warning)_45%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-warning)_10%,var(--color-surface))]"
          : "border-border bg-surface opacity-60 grayscale",
        featured && "opacity-100 grayscale-0",
      )}
      aria-label={t(`items.${key}.title`)}
    >
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] [&>svg]:size-5", a.unlocked ? "bg-[color-mix(in_oklch,var(--color-warning)_22%,transparent)] text-warning" : "bg-bg-muted text-fg-muted")} aria-hidden>
        <Icon />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{t(`items.${key}.title`)}</h3>
          <Badge variant={a.unlocked ? "warning" : "muted"}>{a.unlocked ? t("unlocked") : t("locked")}</Badge>
        </div>
        <p className="text-xs text-fg-muted">{t(`items.${key}.description`)}</p>
        <Progress size="sm" value={pct} tone={a.unlocked ? "warning" : "default"} label={t("progress", { progress: a.progress, goal: a.goal })} />
      </div>
    </m.article>
  );
}
