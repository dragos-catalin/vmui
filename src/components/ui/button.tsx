"use client";
import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium transition-[transform,background-color,color,box-shadow,opacity] duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:brightness-110",
        secondary:
          "bg-[var(--color-surface)] text-[var(--color-fg)] border border-[var(--color-border)] hover:border-[color-mix(in_oklch,var(--color-primary)_55%,var(--color-border))]",
        ghost:
          "bg-transparent text-[var(--color-fg)] hover:bg-[color-mix(in_oklch,var(--color-fg)_8%,transparent)]",
        danger:
          "bg-[var(--color-danger)] text-[var(--color-danger-fg)] hover:brightness-110",
        outline:
          "border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)]",
        link:
          "h-auto bg-transparent px-0 text-[var(--color-primary-text)] underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
        icon: "h-10 w-10 sm:h-9 sm:w-9",
      },
      glow: {
        true: "shadow-[0_8px_24px_-10px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", size: "md", glow: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, glow, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    if (asChild) {
      // Slot needs exactly one child element; the spinner goes INSIDE that child.
      const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode; className?: string }>;
      return (
        <Slot
          ref={ref}
          className={cn(buttonVariants({ variant, size, glow }), loading && "relative", className)}
          aria-busy={loading || undefined}
          aria-disabled={loading || disabled || undefined}
          {...props}
        >
          {loading
            ? React.cloneElement(
                child,
                undefined,
                <>
                  <span className="absolute inset-0 grid place-items-center">
                    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                  </span>
                  <span className="contents invisible">{child.props.children}</span>
                </>,
              )
            : child}
        </Slot>
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, glow }), loading && "relative", className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <span className="absolute inset-0 grid place-items-center">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          </span>
        )}
        <span className={cn("contents", loading && "invisible")}>{children}</span>
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };

