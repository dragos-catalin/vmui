"use client";

import type { RoomGrants, RoomLevel } from "@/lib/home/access-model";
import { ROOMS, type RoomId } from "@/lib/home/catalog";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

type Level = RoomLevel | "none";
const LEVELS: Level[] = ["none", "view", "control"];

/** One row per room, three-state segmented control (none / view / control). */
export function RoomGrantsEditor({ value, onChange, disabled = false }: { value: RoomGrants; onChange: (next: RoomGrants) => void; disabled?: boolean }) {
  const rooms = useTranslations("home.rooms");
  const t = useTranslations("family.level");

  const set = (room: RoomId, level: Level) => {
    const next: RoomGrants = { ...value };
    if (level === "none") delete next[room];
    else next[room] = level;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {ROOMS.map((room) => {
        const current: Level = value[room.id] ?? "none";
        return (
          <div key={room.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <span className="min-w-0 flex-1 basis-24 truncate text-sm" title={rooms(room.id)}>{rooms(room.id)}</span>
            <div role="group" aria-label={rooms(room.id)} className="inline-flex max-w-full shrink-0 rounded-[var(--radius-md)] border border-border-strong">
              {LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={current === level}
                  disabled={disabled}
                  onClick={() => set(room.id, level)}
                  className={cn(
                    "min-h-8 min-w-0 px-2.5 py-1 text-xs font-medium transition-colors first:rounded-l-[calc(var(--radius-md)-1px)] last:rounded-r-[calc(var(--radius-md)-1px)] focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
                    "border-l border-border first:border-l-0",
                    current === level ? "bg-primary text-primary-fg" : "bg-surface text-muted hover:text-fg",
                  )}
                >
                  {t(level)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
