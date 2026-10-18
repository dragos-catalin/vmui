"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useTranslations } from "next-intl";

type ShortcutKey = "palette" | "help" | "search" | "goInstances" | "goAccounts" | "goActivity" | "goSettings" | "new" | "sync" | "theme" | "sidebar" | "escape";

const SHORTCUTS: { keys: string; desc: ShortcutKey }[] = [
  { keys: "⌘ K", desc: "palette" },
  { keys: "?", desc: "help" },
  { keys: "/", desc: "search" },
  { keys: "G I", desc: "goInstances" },
  { keys: "G A", desc: "goAccounts" },
  { keys: "G L", desc: "goActivity" },
  { keys: "G S", desc: "goSettings" },
  { keys: "N", desc: "new" },
  { keys: "R", desc: "sync" },
  { keys: "T", desc: "theme" },
  { keys: "[", desc: "sidebar" },
  { keys: "Esc", desc: "escape" },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useTranslations("shell.shortcuts");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-bg-muted px-3 py-2"
            >
              <span className="min-w-0 text-fg-muted">{t(s.desc)}</span>
              <Kbd className="shrink-0 bg-surface">{s.keys}</Kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
