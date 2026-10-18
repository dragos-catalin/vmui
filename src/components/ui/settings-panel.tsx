"use client";

import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import * as React from "react";

/**
 * Collapsible settings card: a one-line header (icon · title · summary · primary
 * action) that is always visible, and a body that expands on demand. Keeps
 * heavy configuration surfaces (Turzx, Nest Hub, Copilot signals) to one row
 * each until the user wants them. Open state follows `#<id>` in the URL so a
 * link can land on an expanded panel.
 */
export function SettingsPanel({
  id,
  icon,
  title,
  summary,
  action,
  defaultOpen = false,
  children,
  className,
}: {
  id: string;
  icon?: React.ReactNode;
  title: React.ReactNode;
  summary?: React.ReactNode;
  /** Rendered in the header, outside the toggle (e.g. Save). */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === `#${id}`) setOpen(true);
  }, [id]);
  const bodyId = `${id}-body`;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("surface overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 basis-full items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:basis-auto"
        >
          {icon && <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-bg-muted)] text-[var(--color-primary)] [&>svg]:size-4.5">{icon}</span>}
          <span className="min-w-0 flex-1">
            <span id={`${id}-title`} className="block truncate text-sm font-semibold">{title}</span>
            {summary && <span className="block text-xs leading-snug text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{summary}</span>}
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div id={bodyId} hidden={!open} className="border-t border-[var(--color-border)] px-4 py-4 sm:px-5 sm:py-5">
        {children}
      </div>
    </section>
  );
}

/** Plain section card with a header row — for panels that should always be open. */
export function Panel({ title, description, action, children, className, id }: { id?: string; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("surface p-4 sm:p-5", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[12rem]">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-snug text-muted">{description}</p>}
        </div>
        {action && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

/** Titled group inside a panel body: uppercase eyebrow + optional hint + content.
 *  `collapsible` renders a native <details> so long panels stay scannable. */
export function Subsection({ title, hint, action, children, className, collapsible = false, defaultOpen = true }: { title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; collapsible?: boolean; defaultOpen?: boolean }) {
  if (collapsible) {
    return (
      <details open={defaultOpen} className={cn("group rounded-xl border border-[var(--color-border)]", className)}>
        <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted">{title}</span>
            {hint && <span className="mt-0.5 block text-xs leading-snug text-muted">{hint}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {action}
            <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">{children}</div>
      </details>
    );
  }
  return (
    <div className={cn("space-y-4 rounded-xl border border-[var(--color-border)] p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">{title}</p>
          {hint && <p className="mt-0.5 text-xs leading-snug text-muted">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/** Label above a control. `inline` puts label and control on one row (switches, short inputs). */
export function Field({ label, hint, children, className, inline = false }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string; inline?: boolean }) {
  if (inline) {
    return (
      <label className={cn("flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm", className)}>
        <span className="min-w-0">
          <span className="block leading-snug">{label}</span>
          {hint && <span className="block text-xs leading-snug text-muted">{hint}</span>}
        </span>
        <span className="flex shrink-0 items-center">{children}</span>
      </label>
    );
  }
  return (
    <label className={cn("block min-w-0 space-y-1.5", className)}>
      <span className="block text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-snug text-muted">{hint}</span>}
    </label>
  );
}
