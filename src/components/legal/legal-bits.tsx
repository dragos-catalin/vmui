import { cn } from "@/lib/utils";

/** Bulleted list of message strings (next-intl `t.raw` arrays). */
export function LegalList({ items, ordered = false }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={cn("space-y-1.5 pl-5 text-sm leading-relaxed", ordered ? "list-decimal" : "list-disc")}>
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </Tag>
  );
}

export function LegalText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>;
}

/** A contact value that is still the publisher's default placeholder gets a visible marker. */
export function Placeholder({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <span className="ml-2 rounded bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] px-1.5 py-0.5 text-2xs font-medium text-fg" title={label}>
      {label}
    </span>
  );
}

export function MailLink({ email }: { email: string }) {
  return (
    <a href={`mailto:${email}`} className="font-medium text-primary-text underline underline-offset-4">
      {email}
    </a>
  );
}
