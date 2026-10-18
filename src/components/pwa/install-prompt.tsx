"use client";

import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { Download, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

const STORAGE_KEY = "vmui:install:dismissed";
const SHOWN_KEY = "vmui:install:shown";

export function InstallPrompt() {
  const t = useTranslations("misc.install");
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "1") return;
    if (localStorage.getItem(SHOWN_KEY) === "1") return;

    const handler = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
      const t = setTimeout(() => {
        setVisible(true);
        localStorage.setItem(SHOWN_KEY, "1");
      }, 30_000);
      return () => clearTimeout(t);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!visible || !event) return null;

  const dismiss = () => {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, "1");
    haptic("tap");
  };

  const install = async () => {
    haptic("confirm");
    try {
      await event.prompt();
      await event.userChoice;
    } finally {
      setVisible(false);
      setEvent(null);
      localStorage.setItem(STORAGE_KEY, "1");
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("title")}
      className="fixed inset-x-3 z-[var(--z-overlay)] rounded-[var(--radius-xl)] border border-border bg-surface p-3 shadow-lg backdrop-blur-md md:inset-x-auto md:right-4 md:max-w-sm"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 4.5rem)" }}
    >
      <div className="flex items-start gap-3">
        <img src="/icons/icon-192.png" alt="" width={40} height={40} className="size-10 shrink-0 rounded-[var(--radius-md)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("title")}</p>
          <p className="text-pretty text-xs text-fg-muted">{t("description")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={install}>
              <Download className="size-4" aria-hidden /> {t("install")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={dismiss}>
              {t("notNow")}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("dismiss")}
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Button variant for use on the Settings page; triggers the same flow on demand if a prompt event was captured. */
export function InstallButton() {
  const t = useTranslations("misc.install");
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const install = async () => {
    if (!event) return;
    haptic("confirm");
    try {
      await event.prompt();
      await event.userChoice;
    } finally {
      setEvent(null);
    }
  };

  return (
    <Button type="button" variant="secondary" size="sm" onClick={install} disabled={!event}>
      <Download className="size-4" aria-hidden /> {event ? t("title") : t("unavailable")}
    </Button>
  );
}
