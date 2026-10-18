"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { InstanceRow } from "@/lib/db/schema";
import { detectGpu } from "@/lib/gpu-detect";
import { detectIdle } from "@/lib/idle";
import type { PricedRow } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { Apple, Cpu, Globe, MonitorSmartphone, Moon, Pin, Server, StickyNote } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { ConnectDialog } from "./connect-dialog";
import { CostPill } from "./cost-pill";
import { InstanceActions } from "./instance-actions";
import { InstanceContextMenuWrapper } from "./instance-context-wrapper";
import { instanceMorphName, MorphSurface } from "./instance-hero";
import { instanceLabel } from "./instance-label";
import { useInstanceMenuItems } from "./instance-menu";
import { InstanceMenuButton } from "./instance-menu-button";
import { InstanceStatsDialog } from "./instance-stats-dialog";
import { InstanceStatsInline } from "./instance-stats-inline";
import { NotesDialog } from "./notes-dialog";
import { RenameInstanceDialog } from "./rename-dialog";
import { StatusBadge } from "./status-badge";
import { VmScreenshot } from "./vm-screenshot";

const platformIcon = (p: string) => {
  if (p === "macos") return Apple;
  if (p === "windows") return MonitorSmartphone;
  return Server;
};

export function InstanceCard({
  instance,
  index = 0,
  selected,
  onToggleSelect,
  selectionActive,
  price,
}: {
  instance: InstanceRow;
  index?: number;
  selected?: boolean;
  onToggleSelect?: (id: string, additive: boolean) => void;
  selectionActive?: boolean;
  price?: PricedRow;
}) {
  const t = useTranslations("vm.explorer");
  const Icon = platformIcon(instance.platform);
  const [statsOpen, setStatsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const showStats =
    (instance.provider === "local-kvm" || instance.provider === "aws") &&
    instance.state === "running";
  const showScreenshot = instance.provider === "local-kvm";
  const label = instanceLabel(instance);

  const menuItems = useInstanceMenuItems(instance, {
    rename: () => setRenameOpen(true),
    notes: () => setNotesOpen(true),
    connect: () => setConnectOpen(true),
    stats: showStats ? () => setStatsOpen(true) : undefined,
  });

  function handleClick(e: React.MouseEvent) {
    if (selectionActive && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(instance.id, e.metaKey || e.ctrlKey || e.shiftKey);
    }
  }
  const gpu = detectGpu(instance.instanceType);
  const idle = detectIdle({ state: instance.state, lastStateChangeAt: instance.lastStateChangeAt });

  return (
    <>
      <m.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.03 }}
        onClick={handleClick}
      >
        <MorphSurface name={instanceMorphName(instance.id)}>
        <InstanceContextMenuWrapper items={menuItems}>
          <Card
            className={cn(
              "card-hover cursor-default transition-[border-color,box-shadow]",
              selected && "border-[color-mix(in_oklch,var(--color-primary)_55%,var(--color-border))] shadow-[var(--shadow-glow)]",
            )}
            aria-selected={selectionActive ? selected : undefined}
          >
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="relative grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-bg-muted text-fg-muted">
                    <Icon className="size-4" aria-hidden />
                    {instance.pinned && (
                      <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-primary text-primary-fg" title={t("pinned")}>
                        <Pin className="size-2.5" aria-hidden />
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Link
                        href={`/instances/${encodeURIComponent(instance.id)}`}
                        onClick={(e) => {
                          if (selectionActive) e.preventDefault();
                        }}
                        className="block min-w-0 truncate font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setRenameOpen(true);
                        }}
                        title={label}
                      >
                        {label}
                      </Link>
                      {instance.notes && (
                        <span title={instance.notes} aria-label={t("hasNotes")}>
                          <StickyNote className="size-3 shrink-0 text-warning" aria-hidden />
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted" title={`${instance.providerInstanceId} · ${instance.instanceType ?? "—"}`}>
                      {instance.providerInstanceId} · {instance.instanceType ?? "—"}
                    </div>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <StatusBadge state={instance.state} />
                  {gpu && (
                    <Badge variant="info" title={t("gpu", { count: gpu.count, model: gpu.model })} className="hidden gap-1 sm:inline-flex">
                      <Cpu className="size-3" aria-hidden /> {gpu.count}×{gpu.model}
                    </Badge>
                  )}
                  {idle.isIdle && (
                    <Badge variant="warning" title={t("idleHint", { days: idle.idleDays })} className="gap-1">
                      <Moon className="size-3" aria-hidden /> {t("idle", { days: idle.idleDays })}
                    </Badge>
                  )}
                  <InstanceMenuButton items={menuItems} />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {showScreenshot && (
                <div className="mb-3">
                  <VmScreenshot
                    accountId={instance.accountId}
                    enabled={instance.state === "running"}
                    maxWidth={400}
                  />
                </div>
              )}
              {showStats && (
                <div className="mb-3">
                  <InstanceStatsInline
                    enabled={showStats}
                    instanceId={instance.id}
                    onOpenDetails={() => setStatsOpen(true)}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
                  <Globe className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{instance.region}</span>
                  {instance.publicIp && (
                    <>
                      <span className="opacity-40">·</span>
                      <span className="truncate font-mono text-2xs" title={instance.publicIp}>{instance.publicIp}</span>
                    </>
                  )}
                </div>
                <InstanceActions instance={instance} />
              </div>
              {price && (
                <div className="mt-2 border-t border-border pt-2">
                  <CostPill usdPerHour={price.usdPerHour} source={price.source} />
                </div>
              )}
            </CardContent>
          </Card>
        </InstanceContextMenuWrapper>
        </MorphSurface>
      </m.div>
      <RenameInstanceDialog open={renameOpen} onOpenChange={setRenameOpen} instance={instance} />
      <NotesDialog open={notesOpen} onOpenChange={setNotesOpen} instance={instance} />
      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} instance={instance} />
      {showStats && (
        <InstanceStatsDialog open={statsOpen} onOpenChange={setStatsOpen} instance={instance} />
      )}
    </>
  );
}
