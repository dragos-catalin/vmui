import { cn } from "@/lib/utils";
import * as React from "react";

export type PageShellWidth = "content" | "narrow" | "prose" | "full";

const WIDTHS: Record<PageShellWidth, string> = {
  content: "max-w-[var(--spacing-content)]",
  narrow: "max-w-3xl",
  prose: "max-w-2xl",
  full: "",
};

export function PageShell({
  width = "content",
  children,
  className,
}: {
  width?: PageShellWidth;
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("page-enter mx-auto w-full space-y-6", WIDTHS[width], className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  icon,
  actions,
  breadcrumbs,
  badge,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("space-y-2", className)}>
      {breadcrumbs && <div className="text-xs text-fg-muted">{breadcrumbs}</div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-bg-muted text-primary-text [&>svg]:size-5" aria-hidden>
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-[-0.01em]">{title}</h1>
              {badge}
            </div>
            {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex min-w-0 flex-wrap gap-2 sm:shrink-0">{actions}</div>}
      </div>
    </header>
  );
}

export function PageSection({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const autoId = React.useId();
  const titleId = `${id ?? autoId}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className={cn("surface min-w-0 p-4 sm:p-5", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[12rem]">
          <h2 id={titleId} className="font-display text-base font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs leading-snug text-fg-muted">{description}</p>}
        </div>
        {action && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}
