"use client";

import { cn } from "@/lib/utils";
import * as m from "motion/react-m";
import * as React from "react";
import { EmptyArt, type EmptyIllustration } from "./empty-illustrations";

export type { EmptyIllustration } from "./empty-illustrations";

export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  compact = false,
  fill = false,
  bare = false,
  tone = "default",
  className,
}: {
  icon?: React.ReactNode;
  /** Vatra line illustration; wins over `icon` when both are given. */
  illustration?: EmptyIllustration;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  /** Centre the panel in a tall region (pages whose only content is this empty state). */
  fill?: boolean;
  /** No dashed border: use inside a Card/section/table that already draws the frame. */
  bare?: boolean;
  /** `error` renders the panel as an alert (role="alert") with a danger outline. */
  tone?: "default" | "error";
  className?: string;
}) {
  const panel = (
    <m.div
      role={tone === "error" ? "alert" : undefined}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] px-6 text-center",
        !bare && "border border-dashed",
        !bare && (tone === "error" ? "border-[color-mix(in_oklch,var(--color-danger)_45%,var(--color-border))]" : "border-border"),
        compact ? "py-6" : "py-12",
        fill && "w-full max-w-2xl sm:py-16",
        className,
      )}
    >
      {illustration ? (
        <EmptyArt kind={illustration} className={cn("text-fg-soft", compact && "h-14 w-auto")} />
      ) : (
        icon && (
          <span
            className={cn(
              "grid size-11 place-items-center rounded-full bg-bg-muted [&>svg]:size-5",
              tone === "error" ? "text-danger" : "text-fg-muted",
            )}
            aria-hidden
          >
            {icon}
          </span>
        )
      )}
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="mx-auto max-w-sm text-balance text-sm text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </m.div>
  );
  if (!fill) return panel;
  return <div className="grid min-h-[50dvh] min-w-0 place-items-center">{panel}</div>;
}
