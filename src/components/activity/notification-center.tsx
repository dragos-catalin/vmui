"use client";

import { Badge, Button, EmptyState, ScrollFade, ToggleGroup, type ToggleOption } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import type { NotificationRow } from "@/lib/db/schema";
import { dismissAllNotificationsAction, dismissNotificationAction, markAllSeenAction } from "@/server/actions/notifications";
import { AlertCircle, AlertTriangle, Bell, CheckCheck, CheckCircle2, ExternalLink, Info, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as Mo from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";

type Severity = NotificationRow["severity"];
type Filter = "all" | "unread" | Severity;

const ICON: Record<Severity, typeof Bell> = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: AlertCircle };
const VARIANT: Record<Severity, "info" | "success" | "warning" | "danger"> = { info: "info", success: "success", warning: "warning", error: "danger" };
const TONE: Record<Severity, string> = { info: "text-info", success: "text-success", warning: "text-warning", error: "text-danger" };

export interface NotificationItem {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: number;
  seenAt: number | null;
  dismissedAt: number | null;
}

const asResult =
  <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
  async (...a: A): Promise<ActionResult> => {
    await fn(...a);
    return { ok: true };
  };

export function NotificationCenter({ items }: { items: NotificationItem[] }) {
  const t = useTranslations("observe.notifications");
  const format = useFormatter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [category, setCategory] = React.useState<string>("all");

  const dismiss = useAction(asResult(dismissNotificationAction));
  const dismissAll = useAction(asResult(dismissAllNotificationsAction), { success: t("dismissedAll") });
  const markSeen = useAction(asResult(markAllSeenAction), { success: t("markedRead") });

  const categories = React.useMemo(() => Array.from(new Set(items.map((i) => i.category))).sort(), [items]);
  const undismissed = items.filter((i) => !i.dismissedAt);
  const unread = undismissed.filter((i) => !i.seenAt);

  const visible = items.filter((i) => {
    if (category !== "all" && i.category !== category) return false;
    if (filter === "all") return true;
    if (filter === "unread") return !i.seenAt && !i.dismissedAt;
    return i.severity === filter;
  });

  const groups = React.useMemo(() => {
    const m = new Map<string, NotificationItem[]>();
    for (const n of visible) {
      const key = new Date(n.createdAt).toDateString();
      const arr = m.get(key) ?? [];
      arr.push(n);
      m.set(key, arr);
    }
    return [...m.entries()];
  }, [visible]);

  const filterOptions: ToggleOption<Filter>[] = [
    { value: "all", label: t("filters.all") },
    { value: "unread", label: t("filters.unread") },
    { value: "error", label: t("severity.error") },
    { value: "warning", label: t("severity.warning") },
    { value: "info", label: t("severity.info") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ScrollFade label={t("filters.label")} activeKey={filter} className="max-w-full">
          <ToggleGroup value={filter} onValueChange={setFilter} options={filterOptions} size="sm" aria-label={t("filters.label")} className="flex-nowrap" />
        </ScrollFade>
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("filters.category")}>
            <Chip active={category === "all"} onClick={() => setCategory("all")}>
              {t("filters.all")}
            </Chip>
            {categories.map((c) => (
              <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {unread.length > 0 && (
            <Button size="sm" variant="ghost" loading={markSeen.pending} onClick={() => void markSeen.run()}>
              <CheckCheck className="size-4" aria-hidden /> {t("markAllRead")}
            </Button>
          )}
          {undismissed.length > 0 && (
            <Button size="sm" variant="secondary" loading={dismissAll.pending} onClick={() => void dismissAll.run()}>
              <X className="size-4" aria-hidden /> {t("dismissAll")}
            </Button>
          )}
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState illustration="activity" icon={<Bell />} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, list]) => (
            <section key={day} aria-label={format.dateTime(new Date(day), { dateStyle: "full" })}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                {format.dateTime(new Date(day), { dateStyle: "full" })}
              </h2>
              <ul className="space-y-2">
                <AnimatePresence initial={false}>
                  {list.map((n, i) => {
                    const Icon = ICON[n.severity];
                    return (
                      <Mo.li
                        key={n.id}
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 24 }}
                        transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                        className={`surface card-hover flex items-start gap-3 p-3 ${n.dismissedAt ? "opacity-60" : ""}`}
                      >
                        <span className={`mt-0.5 shrink-0 ${TONE[n.severity]}`} aria-hidden>
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`min-w-0 truncate text-sm ${n.seenAt || n.dismissedAt ? "" : "font-semibold"}`}>{n.title}</span>
                            {!n.seenAt && !n.dismissedAt && <Badge variant="info" dot>{t("new")}</Badge>}
                            <Badge variant={VARIANT[n.severity]}>{t(`severity.${n.severity}`)}</Badge>
                            <Badge variant="muted">{n.category}</Badge>
                          </div>
                          {n.body && <p className="mt-1 text-xs text-fg-muted">{n.body}</p>}
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-fg-muted">
                            <time dateTime={new Date(n.createdAt).toISOString()}>{format.dateTime(new Date(n.createdAt), { timeStyle: "short" })}</time>
                            {n.dismissedAt && <span>· {t("dismissed")}</span>}
                            {n.href && (
                              <Link href={n.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                                {t("open")} <ExternalLink className="size-3" aria-hidden />
                              </Link>
                            )}
                          </div>
                        </div>
                        {!n.dismissedAt && (
                          <Button size="icon" variant="ghost" aria-label={t("dismiss")} className="shrink-0" onClick={() => void dismiss.run(n.id)}>
                            <X className="size-4" aria-hidden />
                          </Button>
                        )}
                      </Mo.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-8 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] text-primary" : "border-border text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
