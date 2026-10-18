"use client";

import { InstallPrompt } from "@/components/pwa/install-prompt";
import { syncAllAccounts } from "@/server/actions/instances";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CommandPalette } from "./command-palette";
import { startNavProgress } from "./nav-progress";
import { isEditableTarget, PALETTE_EVENT, toggleSidebarRail } from "./shell-events";
import { ShortcutsDialog } from "./shortcuts-dialog";

/**
 * Mounts the command palette + shortcuts overlay and wires the global
 * keyboard listeners. Designed to be dropped into the root layout once.
 *
 * Hotkeys:
 *   ⌘K / Ctrl+K  → command palette
 *   ?            → shortcuts dialog
 *   N            → /instances/new
 *   R            → sync all accounts
 *   T            → toggle theme
 *   [            → collapse / expand the sidebar rail
 *   G then I/A/L/S → go to instances/accounts/log/settings
 *
 * Single-key shortcuts never fire while focus is in a text field or a composite widget
 * (combobox, listbox, grid, menu, slider) — WCAG 2.1.4.
 */
export function GlobalOverlays() {
  const router = useRouter();
  const t = useTranslations("nav");
  const { resolvedTheme, setTheme } = useTheme();
  const [, start] = useTransition();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const goPrefix = useRef<{ at: number } | null>(null);

  const syncNow = useCallback(() => {
    start(async () => {
      try {
        const r = await syncAllAccounts();
        toast.success(t("synced", { accounts: r.accounts, instances: r.instances }));
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t("syncFailed"));
      }
    });
  }, [router, t]);

  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener(PALETTE_EVENT, open);
    return () => window.removeEventListener(PALETTE_EVENT, open);
  }, []);

  useEffect(() => {
    const go = (href: string) => {
      startNavProgress(href);
      router.push(href);
    };
    function onKey(e: KeyboardEvent) {
      // ⌘K / Ctrl+K: always open palette, even when typing.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        return;
      }
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      // An open modal (dialog/sheet/menu) owns the keyboard.
      if (document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 'go to' two-key sequence: G then I/A/L/S
      if (goPrefix.current && Date.now() - goPrefix.current.at < 1500) {
        goPrefix.current = null;
        switch (e.key.toLowerCase()) {
          case "i":
            e.preventDefault();
            go("/");
            return;
          case "a":
            e.preventDefault();
            go("/accounts");
            return;
          case "l":
            e.preventDefault();
            go("/activity");
            return;
          case "s":
            e.preventDefault();
            go("/settings");
            return;
        }
      }

      switch (e.key) {
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          return;
        case "g":
        case "G":
          goPrefix.current = { at: Date.now() };
          return;
        case "n":
        case "N":
          e.preventDefault();
          go("/instances/new");
          return;
        case "r":
        case "R":
          e.preventDefault();
          syncNow();
          return;
        case "t":
        case "T":
          e.preventDefault();
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          return;
        case "[":
          e.preventDefault();
          toggleSidebarRail();
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolvedTheme, router, setTheme, syncNow]);

  return (
    <>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <InstallPrompt />
    </>
  );
}
