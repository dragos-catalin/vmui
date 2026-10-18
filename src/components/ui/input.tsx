import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-[var(--color-fg-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:border-ring aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
