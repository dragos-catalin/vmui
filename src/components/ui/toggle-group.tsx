"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

export interface ToggleOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export function ToggleGroup<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly ToggleOption<T>[];
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const refs = React.useRef<Map<T, HTMLButtonElement>>(new Map());
  // Roving tabindex needs exactly one tab stop even when `value` matches no option.
  const tabStop = options.some((o) => o.value === value && !o.disabled) ? value : options.find((o) => !o.disabled)?.value;

  const move = (from: number, dir: 1 | -1 | "first" | "last") => {
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((o) => o.value === options[from]?.value);
    const next = dir === "first" ? enabled[0] : dir === "last" ? enabled.at(-1) : enabled[(current + dir + enabled.length) % enabled.length];
    if (!next) return;
    onValueChange(next.value);
    refs.current.get(next.value)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn("inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-[var(--radius-md)] border border-border bg-bg-muted p-0.5", className)}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) refs.current.set(opt.value, el);
              else refs.current.delete(opt.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={opt.value === tabStop ? 0 : -1}
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(i, "first");
              } else if (e.key === "End") {
                e.preventDefault();
                move(i, "last");
              }
            }}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-md)-2px)] font-medium transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:size-4",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
              selected ? "bg-surface text-fg shadow-[var(--shadow-sm)]" : "text-fg-muted hover:text-fg",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
