"use client";

import type { InstanceRow } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { instanceAction, syncAllAccounts } from "@/server/actions/instances";
import { listPaletteIndex, type PaletteIndex } from "@/server/actions/palette";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command, useCommandState } from "cmdk";
import {
    Activity,
    Boxes,
    Cloud,
    CornerDownLeft,
    KeyRound,
    Moon,
    Play,
    Plug,
    Plus,
    RefreshCw,
    RotateCw,
    Search,
    Server,
    Settings as SettingsIcon,
    Square,
    Sun,
    Tag as TagIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { startNavProgress } from "./nav-progress";
import { PALETTE_LAYOUT_ID, setPaletteOpenState } from "./shell-events";

type CommandItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  /** Single-key shortcut shown as a kbd. */
  shortcut?: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  run: () => void | Promise<void>;
};

const SPRING = { type: "spring", stiffness: 380, damping: 32 } as const;

/**
 * Command palette on cmdk (combobox + listbox ARIA, active-descendant, type-ahead filtering) inside a
 * Radix dialog (focus trap/return). The surface shares a Motion layoutId with the topbar search button,
 * so it grows out of the button on open and shrinks back into it on close.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const t = useTranslations("shell.palette");
  const { resolvedTheme, setTheme } = useTheme();
  const [, start] = useTransition();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<PaletteIndex | null>(null);

  useEffect(() => {
    setPaletteOpenState(open);
    if (!open) return;
    setQuery("");
    listPaletteIndex()
      .then(setIndex)
      .catch(() => setIndex(null));
  }, [open]);

  useEffect(() => () => setPaletteOpenState(false), []);

  const items = useMemo<CommandItem[]>(() => {
    const go = (href: string) => {
      startNavProgress(href);
      router.push(href);
    };
    const groups = {
      navigate: t("groups.navigate"),
      actions: t("groups.actions"),
      instances: t("groups.instances"),
      accounts: t("groups.accounts"),
      resources: t("groups.resources"),
      tags: t("groups.tags"),
    };
    const requested = (verb: "start" | "stop" | "reboot") => t(`vm.requested.${verb}`);
    const vmAction = (verb: "start" | "stop" | "reboot", i: InstanceRow) => () =>
      start(async () => {
        const r = await instanceAction(verb, { accountId: i.accountId, region: i.region, providerInstanceId: i.providerInstanceId });
        if (r.ok) toast.success(requested(verb));
        else toast.error(r.error ?? t("actions.failed"));
        router.refresh();
      });

    const out: CommandItem[] = [
      { id: "nav:dashboard", group: groups.navigate, label: t("nav.dashboard"), icon: Server, run: () => go("/") },
      { id: "nav:accounts", group: groups.navigate, label: t("nav.accounts"), icon: KeyRound, run: () => go("/accounts") },
      { id: "nav:activity", group: groups.navigate, label: t("nav.activity"), icon: Activity, run: () => go("/activity") },
      { id: "nav:settings", group: groups.navigate, label: t("nav.settings"), icon: SettingsIcon, run: () => go("/settings") },
      { id: "action:new", group: groups.actions, label: t("actions.new"), shortcut: "N", icon: Plus, run: () => go("/instances/new") },
      {
        id: "action:sync",
        group: groups.actions,
        label: t("actions.sync"),
        shortcut: "R",
        icon: RefreshCw,
        run: () =>
          start(async () => {
            try {
              const r = await syncAllAccounts();
              toast.success(t("actions.synced", { accounts: r.accounts, instances: r.instances }));
              router.refresh();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : t("actions.syncFailed"));
            }
          }),
      },
      {
        id: "action:theme",
        group: groups.actions,
        label: resolvedTheme === "dark" ? t("actions.themeLight") : t("actions.themeDark"),
        shortcut: "T",
        icon: resolvedTheme === "dark" ? Sun : Moon,
        run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
    ];

    for (const i of index?.instances ?? []) {
      const label = i.displayName ?? i.name ?? i.providerInstanceId;
      const href = `/instances/${encodeURIComponent(i.id)}`;
      out.push({
        id: `vm:open:${i.id}`,
        group: groups.instances,
        label: t("vm.open", { name: label }),
        hint: i.provider,
        icon: Server,
        keywords: `${i.providerInstanceId} ${i.region} ${i.publicIp ?? ""} ${i.notes ?? ""}`,
        run: () => go(href),
      });
      if (i.state === "running") {
        out.push(
          { id: `vm:connect:${i.id}`, group: groups.instances, label: t("vm.connect", { name: label }), icon: Plug, run: () => go(href) },
          { id: `vm:stop:${i.id}`, group: groups.instances, label: t("vm.stop", { name: label }), icon: Square, run: vmAction("stop", i) },
          { id: `vm:reboot:${i.id}`, group: groups.instances, label: t("vm.reboot", { name: label }), icon: RotateCw, run: vmAction("reboot", i) },
        );
      } else if (i.state === "stopped") {
        out.push({ id: `vm:start:${i.id}`, group: groups.instances, label: t("vm.start", { name: label }), icon: Play, run: vmAction("start", i) });
      }
    }

    for (const a of index?.accounts ?? []) {
      out.push({
        id: `account:${a.id}`,
        group: groups.accounts,
        label: a.name,
        hint: a.provider,
        icon: Cloud,
        keywords: `${a.provider} ${a.defaultRegion ?? ""}`,
        run: () => go(`/accounts/${encodeURIComponent(a.id)}`),
      });
    }

    for (const r of (index?.resources ?? []).slice(0, 200)) {
      out.push({
        id: `res:${r.id}`,
        group: groups.resources,
        label: r.name ?? r.externalId,
        hint: `${r.kind} · ${r.region}`,
        icon: Boxes,
        keywords: `${r.provider} ${r.kind} ${r.externalId} ${r.region}`,
        run: () => go(`/resources?kind=${encodeURIComponent(r.kind)}&q=${encodeURIComponent(r.externalId)}`),
      });
    }

    const seen = new Set<string>();
    for (const tag of index?.tags ?? []) {
      const k = `${tag.key}=${tag.value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: `tag:${k}`,
        group: groups.tags,
        label: tag.value ? `${tag.key}: ${tag.value}` : tag.key,
        icon: TagIcon,
        keywords: `${tag.key} ${tag.value}`,
        run: () => go(`/tags?key=${encodeURIComponent(tag.key)}${tag.value ? `&value=${encodeURIComponent(tag.value)}` : ""}`),
      });
    }
    return out;
  }, [index, resolvedTheme, router, setTheme, t]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const it of items) {
      const arr = map.get(it.group) ?? [];
      arr.push(it);
      map.set(it.group, arr);
    }
    return [...map.entries()];
  }, [items]);

  const select = (item: CommandItem) => {
    onOpenChange(false);
    void item.run();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-[var(--z-modal)] bg-overlay backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
              />
            </DialogPrimitive.Overlay>
            <div className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-start justify-center px-3 pt-[min(12dvh,6rem)]">
              <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                <m.div
                  layoutId={PALETTE_LAYOUT_ID}
                  transition={SPRING}
                  style={{ borderRadius: 24 }}
                  className="glass pointer-events-auto w-full max-w-xl overflow-hidden shadow-[var(--shadow-lg)] outline-none"
                >
                  <DialogPrimitive.Title className="sr-only">{t("title")}</DialogPrimitive.Title>
                  <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12, delay: 0.04 }}>
                    <Command label={t("title")} loop className="flex flex-col">
                      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                        <Search className="size-4 shrink-0 text-fg-muted" aria-hidden />
                        <Command.Input
                          value={query}
                          onValueChange={setQuery}
                          placeholder={t("placeholder")}
                          aria-label={t("title")}
                          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-muted"
                        />
                        <kbd className="hidden rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-2xs text-fg-muted sm:inline">esc</kbd>
                      </div>
                      <Command.List className="max-h-[min(60dvh,28rem)] overflow-y-auto overscroll-contain p-1.5 [scrollbar-width:thin]">
                        <Command.Empty className="p-6 text-center text-sm text-fg-muted">{t("noMatches")}</Command.Empty>
                        {grouped.map(([group, list]) => (
                          <Command.Group
                            key={group}
                            heading={group}
                            className="mb-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-muted"
                          >
                            {list.map((item) => {
                              const Icon = item.icon;
                              return (
                                <Command.Item
                                  key={item.id}
                                  value={item.id}
                                  keywords={[item.label, item.group, item.hint ?? "", item.keywords ?? ""]}
                                  onSelect={() => select(item)}
                                  className={cn(
                                    "group flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left text-sm text-fg-muted transition-colors",
                                    "data-[selected=true]:bg-[color-mix(in_oklch,var(--color-primary)_16%,transparent)] data-[selected=true]:text-fg",
                                  )}
                                >
                                  <Icon className="size-4 shrink-0 group-data-[selected=true]:text-primary-text" aria-hidden />
                                  <span className="min-w-0 flex-1 truncate" title={item.label}>
                                    {item.label}
                                  </span>
                                  {item.hint && <span className="shrink-0 text-2xs text-fg-muted">{item.hint}</span>}
                                  {item.shortcut && (
                                    <kbd className="shrink-0 rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-2xs" aria-hidden>
                                      {item.shortcut}
                                    </kbd>
                                  )}
                                  <CornerDownLeft className="invisible size-3.5 shrink-0 text-primary-text group-data-[selected=true]:visible" aria-hidden />
                                </Command.Item>
                              );
                            })}
                          </Command.Group>
                        ))}
                      </Command.List>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-muted px-3 py-2 text-2xs text-fg-muted">
                        <span>{t("hints")}</span>
                        <FilteredCount />
                      </div>
                    </Command>
                  </m.div>
                </m.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

function FilteredCount() {
  const t = useTranslations("shell.palette");
  const n = useCommandState((s) => s.filtered.count);
  return <span aria-live="polite">{t("count", { n })}</span>;
}