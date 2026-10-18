import { cn } from "@/lib/utils";
import * as React from "react";

type Variant = "default" | "success" | "warning" | "danger" | "info" | "muted";
const styles: Record<Variant, string> = {
  default:
    "bg-[color-mix(in_oklch,var(--color-fg)_8%,transparent)] text-[var(--color-fg)]",
  success:
    "bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color-mix(in_oklch,var(--color-success)_75%,var(--color-fg))]",
  warning:
    "bg-[color-mix(in_oklch,var(--color-warning)_22%,transparent)] text-warning-text",
  danger:
    "bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color-mix(in_oklch,var(--color-danger)_80%,var(--color-fg))]",
  info: "bg-[color-mix(in_oklch,var(--color-primary)_16%,transparent)] text-primary-text",
  muted: "bg-[var(--color-bg-muted)] text-fg-muted",
};

export function Badge({
  children,
  variant = "default",
  className,
  dot,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-2xs font-medium",
        styles[variant],
        className,
      )}
      {...props}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current pulse-dot" aria-hidden />}
      {children}
    </span>
  );
}
