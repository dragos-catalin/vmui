"use client";

import { Button, Field, Input } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Copy, ExternalLink, HelpCircle, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

export function ConnectPanel({
  icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface space-y-4 p-4 sm:p-5", className)}>
      <header className="flex items-start gap-3">
        {icon && (
          <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-primary)_15%,transparent)] text-primary [&>svg]:size-5" aria-hidden>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-snug text-muted">{description}</p>}
        </div>
        {action && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

export function ConnectField({
  name,
  label,
  hint,
  error,
  id,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "name"> & {
  name: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
}) {
  return (
    <Field label={label} hint={error ? <span className="text-danger">{error}</span> : hint}>
      <Input id={id ?? name} name={name} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export function ConnectSelect({
  name,
  label,
  hint,
  error,
  value,
  onValueChange,
  options,
}: {
  name: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: readonly { value: string; label: React.ReactNode }[];
}) {
  return (
    <Field label={label} hint={error ? <span className="text-danger">{error}</span> : hint}>
      <Select name={name} value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-invalid={error ? true : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SubmitButton({ pending, provider, className }: { pending: boolean; provider: string; className?: string }) {
  const t = useTranslations("cloud.connect.common");
  return (
    <Button type="submit" loading={pending} size="lg" className={className}>
      <ShieldCheck className="size-4" aria-hidden /> {pending ? t("verifying", { provider }) : t("verifyConnect")}
    </Button>
  );
}

export function EncryptedNote() {
  const t = useTranslations("cloud.connect.common");
  return (
    <span className="inline-flex items-center gap-2 text-xs text-success">
      <ShieldCheck className="size-4 shrink-0" aria-hidden />
      {t("encrypted")}
    </span>
  );
}

export function Step({ n, title, children }: { n: number; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] text-xs font-semibold text-primary" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="space-y-2 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

export function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warning" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-[var(--radius-md)] p-3 text-xs",
        tone === "warning" ? "bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)] text-fg" : "bg-bg-muted text-muted",
      )}
    >
      <HelpCircle className={cn("size-4 shrink-0", tone === "warning" && "text-warning")} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ExternalLinkRow({ href, label }: { href: string; label: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-10 items-center gap-1 rounded-[var(--radius-sm)] text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-0"
    >
      <ExternalLink className="size-3" aria-hidden /> {label}
    </a>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: React.ReactNode }) {
  const t = useTranslations("cloud.connect.common");
  const tc = useTranslations("common");
  function copy() {
    void navigator.clipboard.writeText(code);
    toast.success(t("copied"));
  }
  return (
    <div className="space-y-1">
      {label && <div className="text-[11px] font-medium text-muted">{label}</div>}
      <div className="group relative">
        <pre
          role="region"
          aria-label={typeof label === "string" ? label : tc("scrollRegion")}
          tabIndex={0}
          className="overflow-x-auto rounded-[var(--radius-md)] bg-bg-muted p-3 pr-12 font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {code}
        </pre>
        <Button type="button" variant="ghost" size="icon" onClick={copy} className="absolute right-1 top-1 size-9" aria-label={t("copy")}>
          <Copy className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function CodePill({ text }: { text: string }) {
  const t = useTranslations("cloud.connect.common");
  function copy() {
    void navigator.clipboard.writeText(text);
    toast.success(t("copied"));
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t("copyValue", { value: text })}
      className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-[color-mix(in_oklch,var(--color-fg)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {text}
      <Copy className="size-2.5 opacity-60" aria-hidden />
    </button>
  );
}

/** Tag renderers for `t.rich()` so guide copy can carry <strong>/<code>/<em>. */
export const RICH = {
  strong: (chunks: React.ReactNode) => <strong className="text-fg">{chunks}</strong>,
  code: (chunks: React.ReactNode) => <code className="rounded-[var(--radius-sm)] bg-bg-muted px-1 font-mono text-[0.9em]">{chunks}</code>,
  em: (chunks: React.ReactNode) => <em>{chunks}</em>,
};
