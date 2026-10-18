"use client";
import { cn } from "@/lib/utils";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--color-primary)] data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-[color-mix(in_oklch,var(--color-fg)_10%,transparent)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-4 rounded-full shadow-[var(--shadow-sm)] ring-0 transition-transform motion-reduce:transition-none",
        "data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-[var(--color-primary-fg)] data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-[var(--color-fg-muted)]",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
