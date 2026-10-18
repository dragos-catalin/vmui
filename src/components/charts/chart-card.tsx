"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BarChart3, RotateCw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

export interface ChartCardProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Body height in px. */
  height?: number;
  loading?: boolean;
  /** When true the body renders a compact EmptyState instead of children. */
  empty?: boolean;
  emptyTitle?: React.ReactNode;
  /** Load failure; wins over `empty`. `onRetry` adds a retry button. */
  error?: React.ReactNode;
  onRetry?: () => void;
  className?: string;
  children?: React.ReactNode;
}

export function ChartCard({ title, description, action, height = 220, loading = false, empty = false, emptyTitle, error, onRetry, className, children }: ChartCardProps) {
  const t = useTranslations("common");
  const id = React.useId();
  return (
    <section aria-labelledby={`${id}-title`} className={cn("surface flex min-w-0 flex-col p-4 sm:p-5", className)}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-[10rem]">
          <h3 id={`${id}-title`} className="truncate text-sm font-semibold" title={typeof title === "string" ? title : undefined}>
            {title}
          </h3>
          {description && <p className="mt-0.5 text-xs leading-snug text-fg-muted">{description}</p>}
        </div>
        {action && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{action}</div>}
      </header>
      <div className="relative min-w-0" style={{ height }}>
        {error ? (
          <EmptyState
            compact
            tone="error"
            icon={<TriangleAlert />}
            title={t("loadFailed")}
            description={typeof error === "string" ? error : undefined}
            className="h-full"
            action={
              onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RotateCw className="size-3.5" aria-hidden />
                  {t("retry")}
                </Button>
              ) : undefined
            }
          />
        ) : loading ? (
          <Skeleton className="h-full w-full rounded-[var(--radius-md)]" />
        ) : empty ? (
          <EmptyState compact bare icon={<BarChart3 />} title={emptyTitle ?? t("noResults")} className="h-full" />
        ) : (
          children
        )}
      </div>
    </section>
  );
}
