"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEventsBus } from "@/hooks/use-poll";
import type { NotificationRow } from "@/lib/db/schema";
import {
    dismissAllNotificationsAction,
    dismissNotificationAction,
    listNotificationsAction,
    markAllSeenAction,
} from "@/server/actions/notifications";
import { AlertCircle, AlertTriangle, Bell, Check, CheckCircle2, Info, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

type BellT = ReturnType<typeof useTranslations<"misc.bell">>;

function relative(iso: string, t: BellT): string {
  const dt = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - dt);
  if (diff < 60_000) return t("justNow");
  if (diff < 3_600_000) return t("minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("hoursAgo", { n: Math.floor(diff / 3_600_000) });
  return t("daysAgo", { n: Math.floor(diff / 86_400_000) });
}

const ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
} as const;

const COLOR = {
  info: "text-primary-text",
  success: "text-success",
  warning: "text-warning-text",
  error: "text-danger",
} as const;

export function NotificationsBell() {
  const t = useTranslations("misc.bell");
  const router = useRouter();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const unseen = items.filter((n) => !n.seenAt && !n.dismissedAt).length;

  async function refresh() {
    const rows = await listNotificationsAction();
    setItems(rows);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEventsBus({
    "notification.created": () => {
      void refresh();
    },
  });

  useEffect(() => {
    if (open && unseen > 0) {
      start(async () => {
        await markAllSeenAction();
        await refresh();
      });
    }
  }, [open, unseen]);

  function dismiss(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, dismissedAt: new Date() } : n)));
    start(async () => {
      await dismissNotificationAction(id);
      router.refresh();
    });
  }

  function dismissAll() {
    setItems((prev) => prev.map((n) => ({ ...n, dismissedAt: new Date() })));
    start(async () => {
      await dismissAllNotificationsAction();
      router.refresh();
    });
  }

  const visible = items.filter((n) => !n.dismissedAt).slice(0, 30);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={unseen > 0 ? t("tooltipNew", { count: unseen }) : t("tooltip")}
              className="relative"
            >
              <Bell className="h-4 w-4" aria-hidden />
              <AnimatePresence>
                {unseen > 0 && (
                  <m.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0 }}
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    aria-hidden
                    className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-2xs font-bold leading-none text-danger-fg ring-2 ring-[var(--color-bg)]"
                  >
                    {unseen > 99 ? "99+" : unseen}
                  </m.span>
                )}
              </AnimatePresence>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{unseen > 0 ? t("tooltipNew", { count: unseen }) : t("tooltip")}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[min(24rem,calc(100vw-1rem))] p-0" collisionPadding={8}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          {visible.length > 0 && (
            <button
              type="button"
              onClick={dismissAll}
              className="min-h-6 rounded-[var(--radius-sm)] px-1.5 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t("clearAll")}
            </button>
          )}
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {visible.length === 0 ? (
            <div className="px-3 py-10 text-center text-xs text-fg-muted">
              <Check className="mx-auto mb-2 h-5 w-5 opacity-60" aria-hidden />
              {t("empty")}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((n) => {
                const Icon = ICON[n.severity];
                const color = COLOR[n.severity];
                const created = n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt);
                const inner = (
                  <div className="flex gap-2.5 pr-7">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="truncate text-sm font-medium" title={n.title}>{n.title}</div>
                        <time dateTime={created} className="shrink-0 text-2xs text-fg-muted">{relative(created, t)}</time>
                      </div>
                      {n.body && <div className="mt-0.5 break-words text-xs text-fg-muted">{n.body}</div>}
                    </div>
                  </div>
                );
                return (
                  <li
                    key={n.id}
                    className="group relative px-3 py-2.5 transition-colors hover:bg-[color-mix(in_oklch,var(--color-fg)_4%,transparent)]"
                  >
                    {n.href ? (
                      <Link
                        href={n.href}
                        onClick={() => setOpen(false)}
                        className="block rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}
                    <button
                      type="button"
                      aria-label={t("dismiss")}
                      onClick={() => dismiss(n.id)}
                      className="absolute right-2 top-2 grid size-6 place-items-center rounded-[var(--radius-sm)] text-fg-muted transition-opacity hover:bg-bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
