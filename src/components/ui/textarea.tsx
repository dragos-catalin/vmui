import { cn } from "@/lib/utils";
import * as React from "react";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-[var(--radius-md)] border border-border-strong bg-[var(--color-surface)] px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-[var(--color-fg-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:border-ring aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
