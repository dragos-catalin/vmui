"use client";

import { cn } from "@/lib/utils";
import { Check, Minus } from "lucide-react";
import * as React from "react";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, onCheckedChange, onChange, disabled, ...props }, ref) => {
    const inner = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => inner.current as HTMLInputElement);
    React.useEffect(() => {
      if (inner.current) inner.current.indeterminate = indeterminate;
    }, [indeterminate]);
    return (
      <span className={cn("relative inline-grid size-5 shrink-0 place-items-center", disabled && "opacity-50", className)}>
        <input
          ref={inner}
          type="checkbox"
          disabled={disabled}
          onChange={(e) => {
            onChange?.(e);
            onCheckedChange?.(e.currentTarget.checked);
          }}
          className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-[6px] border-[1.5px] border-border-strong bg-[var(--color-surface)] transition-colors checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] indeterminate:border-[var(--color-primary)] indeterminate:bg-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
          style={{ accentColor: "var(--color-primary)" }}
          {...props}
        />
        <Check className="pointer-events-none invisible size-3.5 text-[var(--color-primary-fg)] peer-checked:visible peer-indeterminate:invisible" aria-hidden strokeWidth={3} />
        <Minus className="pointer-events-none invisible absolute size-3.5 text-[var(--color-primary-fg)] peer-indeterminate:visible" aria-hidden strokeWidth={3} />
      </span>
    );
  },
);
Checkbox.displayName = "Checkbox";
