"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function AuthField({ id, label, hint, error, children }: { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string | null; children: (a11y: Pick<InputProps, "id" | "aria-describedby" | "aria-invalid">) => React.ReactNode }) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5 [&_input]:border-border [&_input:hover]:border-border-strong [&_input:focus-visible]:border-ring [&_input[aria-invalid=true]]:border-danger">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, "type">>(({ className, ...props }, ref) => {
  const t = useTranslations("auth.password");
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={visible ? "text" : "password"} className={cn("pr-10", className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? t("hide") : t("show")}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-[var(--radius-md)] text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
