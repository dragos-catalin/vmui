"use client";

import { Badge, Button, EmptyState, PageSection, ToggleGroup, type ToggleOption } from "@/components/ui";
import { Check, Copy, ScrollText } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

export interface ChangelogDay {
  day: string;
  items: { id: number; action: string; ok: boolean; account: string | null; target: string | null; message: string | null; at: number }[];
}

const WINDOWS = ["1", "7", "30", "60"] as const;

export function ChangelogView({ days, groups, markdown }: { days: number; groups: ChangelogDay[]; markdown: string }) {
  const t = useTranslations("observe.changelog");
  const format = useFormatter();
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);
  const [showMd, setShowMd] = React.useState(false);
  const options: ToggleOption<string>[] = WINDOWS.map((d) => ({ value: d, label: t("window", { count: Number(d) }) }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup value={String(days)} onValueChange={(v) => router.push(`/changelog?days=${v}`)} options={options} size="sm" aria-label={t("windowLabel")} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowMd((v) => !v)} aria-pressed={showMd}>
            <ScrollText className="size-4" aria-hidden /> {showMd ? t("showList") : t("showMarkdown")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void copy()}>
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} {t("copyMarkdown")}
          </Button>
        </div>
      </div>

      {showMd ? (
        <pre className="surface max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{markdown}</pre>
      ) : groups.length === 0 ? (
        <EmptyState illustration="activity" icon={<ScrollText />} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        groups.map((g, gi) => (
          <PageSection key={g.day} title={format.dateTime(new Date(g.day), { dateStyle: "full" })}>
            <ol className="relative space-y-3 pl-6 before:absolute before:bottom-1 before:left-[7px] before:top-1 before:w-px before:bg-border">
              {g.items.map((it, i) => (
                <m.li
                  key={it.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(gi * 3 + i, 12) * 0.03 }}
                  className="relative"
                >
                  <span className={`absolute -left-6 top-1.5 size-[15px] rounded-full ring-4 ring-surface ${it.ok ? "bg-success" : "bg-danger"}`} aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{it.action}</span>
                    <Badge variant="muted">{it.account ?? t("system")}</Badge>
                    {it.target && <code className="min-w-0 truncate font-mono text-xs text-fg-muted">{it.target}</code>}
                    <time dateTime={new Date(it.at).toISOString()} className="ml-auto text-xs tabular-nums text-fg-muted">
                      {format.dateTime(new Date(it.at), { timeStyle: "short" })}
                    </time>
                  </div>
                  {it.message && <p className="mt-0.5 text-xs text-fg-muted">{it.message}</p>}
                </m.li>
              ))}
            </ol>
          </PageSection>
        ))
      )}
    </div>
  );
}
