"use client";

import { Badge, Button } from "@/components/ui";
import type { InstanceRow } from "@/lib/db/schema";
import type { PricedRow } from "@/lib/pricing";
import { Apple, MonitorSmartphone, Plug, Server } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CostPill } from "./cost-pill";
import { instanceLabel } from "./instance-label";
import { InstanceStatsInline } from "./instance-stats-inline";
import { VmScreenshot } from "./vm-screenshot";

const platformIcon = (p: string) => {
  if (p === "macos") return Apple;
  if (p === "windows") return MonitorSmartphone;
  return Server;
};

export function RunningVmsStrip({
  instances,
  priceMap,
}: {
  instances: InstanceRow[];
  priceMap?: Record<string, PricedRow>;
}) {
  const t = useTranslations("dashboard.live");
  if (instances.length === 0) return null;
  return (
    <section aria-label={t("title")}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
          {t("title")}
          <Badge variant="success" dot>
            {t("count", { count: instances.length })}
          </Badge>
        </h2>
      </div>
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-2rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-1 sm:px-1 xl:mx-0 xl:grid xl:grid-cols-3 xl:overflow-visible xl:px-0 xl:[mask-image:none] 3xl:grid-cols-4">
        {instances.map((i, idx) => (
          <m.li
            key={i.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(idx, 8) * 0.035 }}
            className="w-[min(18rem,85vw)] shrink-0 snap-start xl:w-auto"
          >
            <RunningCard instance={i} price={priceMap?.[i.id]} />
          </m.li>
        ))}
      </ul>
    </section>
  );
}

function RunningCard({ instance, price }: { instance: InstanceRow; price?: PricedRow }) {
  const t = useTranslations("dashboard.live");
  const Icon = platformIcon(instance.platform);
  const isKvm = instance.provider === "local-kvm";
  const label = instanceLabel(instance);
  const href = `/instances/${encodeURIComponent(instance.id)}`;
  return (
    // No morph name here: the explorer below renders the same instance, and a
    // duplicate view-transition name aborts the list → detail transition.
    <article className="surface card-hover group relative min-w-0 overflow-hidden p-2" aria-label={label}>
      {isKvm ? (
        <VmScreenshot
          accountId={instance.accountId}
          enabled
          maxWidth={400}
          intervalMs={6000}
          className="aspect-video"
        />
      ) : (
        <div className="relative grid aspect-video place-items-center overflow-hidden rounded-[var(--radius-md)] border border-border bg-gradient-to-br from-[color-mix(in_oklch,var(--color-primary)_25%,var(--color-surface))] to-[color-mix(in_oklch,var(--color-accent)_25%,var(--color-surface))]">
          <div className="absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-[color-mix(in_oklch,var(--color-primary)_40%,transparent)] blur-3xl" aria-hidden />
          <Icon className="relative size-10 text-primary" aria-hidden />
        </div>
      )}

      <div className="mt-2 flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <Link href={href} className="block truncate text-sm font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" title={label}>
            {label}
          </Link>
          <div className="truncate text-2xs text-muted" title={`${instance.region} · ${instance.instanceType ?? t("noType")}`}>
            {instance.region} · {instance.instanceType ?? t("noType")}
          </div>
          {price && (
            <div className="mt-0.5">
              <CostPill usdPerHour={price.usdPerHour} source={price.source} showMonthly={false} />
            </div>
          )}
        </div>
        <Button asChild variant="secondary" size="icon" className="shrink-0">
          <Link href={href} aria-label={t("open", { name: label })} title={t("open", { name: label })}>
            <Plug className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>

      {isKvm && (
        <div className="px-1 pt-1">
          <InstanceStatsInline enabled instanceId={instance.id} />
        </div>
      )}
    </article>
  );
}
