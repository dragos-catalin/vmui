"use client";

import { Button } from "@/components/ui/button";
import { ROOMS, type CatalogDevice, type RoomId } from "@/lib/home/catalog";
import { cn } from "@/lib/utils";
import { placeDeviceAction, resetLayoutAction } from "@/server/actions/home";
import type { PlacedDevice } from "@/server/queries/home";
import { Lock, LockOpen, RotateCcw } from "lucide-react";
import { useMotionValue } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";
import { KIND_ICON } from "./device-icon";
import { deviceLayoutId } from "./home-motion";
import { useHomeAction } from "./use-home-action";
import { cssColor, isOn, useEntity, useHomeStates } from "./use-home-states";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

type Props = {
  devices: PlacedDevice[];
  selected: string | null;
  onSelect: (id: string) => void;
};

/**
 * Top-down plan. Rooms are boxes in percent of the plan; devices are dots in
 * percent of their room. Drag a dot (or focus it and use the arrow keys) to
 * move it in arrange mode; the move is persisted through placeDeviceAction.
 */
export function FloorPlan({ devices, selected, onSelect, canArrange = true }: Props & { canArrange?: boolean }) {
  const t = useTranslations("homeCards.floorPlan");
  const roomName = useTranslations("homeCards.floorPlan.rooms");
  const [arrange, setArrange] = React.useState(false);
  const [local, setLocal] = React.useState(devices);
  const [announce, setAnnounce] = React.useState("");
  const planRef = React.useRef<HTMLDivElement>(null);
  const [planSize, setPlanSize] = React.useState({ w: 0, h: 0 });
  const place = useHomeAction(placeDeviceAction);
  const reset = useHomeAction(resetLayoutAction, { success: t("layoutReset"), refresh: true });
  const pendingSave = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  React.useEffect(() => setLocal(devices), [devices]);
  React.useEffect(() => {
    const timers = pendingSave.current;
    return () => timers.forEach((id) => clearTimeout(id));
  }, []);
  React.useEffect(() => {
    const el = planRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPlanSize((p) => (p.w === r.width && p.h === r.height ? p : { w: r.width, h: r.height }));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const offsets = React.useMemo(() => collisionOffsets(local, planSize), [local, planSize]);

  /** Move to a point in plan percent; the room is whichever box contains it. */
  const moveTo = (d: CatalogDevice, px: number, py: number, delayMs = 0) => {
    const room = ROOMS.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) ?? ROOMS.find((r) => r.id === d.room)!;
    const x = Math.min(96, Math.max(4, ((px - room.x) / room.w) * 100));
    const y = Math.min(94, Math.max(6, ((py - room.y) / room.h) * 100));
    setLocal((prev) => prev.map((p) => (p.id === d.id ? { ...p, room: room.id, x, y, placed: true } : p)));
    setAnnounce(t("position", { name: d.name, room: roomName(room.id), x: Math.round(x), y: Math.round(y) }));
    const timers = pendingSave.current;
    const prev = timers.get(d.id);
    if (prev) clearTimeout(prev);
    timers.set(
      d.id,
      setTimeout(() => {
        timers.delete(d.id);
        void place.run({ deviceId: d.id, room: room.id, x, y });
      }, delayMs),
    );
  };
  const drop = (d: CatalogDevice, clientX: number, clientY: number) => {
    const plan = planRef.current?.getBoundingClientRect();
    if (!plan) return;
    moveTo(d, ((clientX - plan.left) / plan.width) * 100, ((clientY - plan.top) / plan.height) * 100);
  };
  // Keyboard alternative to dragging (WCAG 2.1.1 / 2.5.7): 1 % of the plan per arrow, 5 % with Shift.
  const nudge = (d: PlacedDevice, dx: number, dy: number) => {
    const c = dotCenter(d);
    moveTo(d, Math.min(99, Math.max(1, c.left + dx)), Math.min(99, Math.max(1, c.top + dy)), 500);
  };

  return (
    <div className="mx-auto w-full space-y-3 3xl:max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="floor-plan-hint" className="min-w-0 text-xs text-muted">
          {arrange ? `${t("hintArrange")} ${t("hintKeys")}` : t("hintTap")}
        </p>
        {canArrange && (
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {arrange && (
              <Button variant="ghost" size="sm" loading={reset.pending} onClick={() => void reset.run()}>
                <RotateCcw className="size-3.5" aria-hidden /> {t("reset")}
              </Button>
            )}
            <Button variant={arrange ? "primary" : "outline"} size="sm" onClick={() => setArrange((v) => !v)} aria-pressed={arrange}>
              {arrange ? <LockOpen className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
              {arrange ? t("done") : t("arrange")}
            </Button>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div
        ref={planRef}
        className="relative aspect-[4/3] w-full select-none overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-bg-muted)_60%,transparent)] sm:aspect-[16/10]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in oklch, var(--color-fg) 4%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklch, var(--color-fg) 4%, transparent) 1px, transparent 1px)",
          backgroundSize: "5% 6.6667%",
        }}
      >
        {ROOMS.map((room) => (
          <Room key={room.id} room={room} devices={local.filter((d) => d.room === room.id)} />
        ))}

        {local.map((d) => (
          <DeviceDot
            key={d.id}
            device={d}
            selected={selected === d.id}
            arrange={arrange}
            offset={offsets.get(d.id) ?? ZERO}
            onSelect={() => onSelect(d.id)}
            onDrop={(x, y) => drop(d, x, y)}
            onNudge={(dx, dy) => nudge(d, dx, dy)}
          />
        ))}
      </div>
      <RoomLegend devices={local} />
    </div>
  );
}

// Rendered pill size incl. the value badge; two dots overlap when both axes are closer than this.
const DOT_W_PX = 46;
const DOT_H_PX = 36;
const ZERO = { dx: 0, dy: 0 };
// Candidate slots around the true position, nearest first: below, above, sides, diagonals, then a second ring.
const SLOTS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
  { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 },
  { dx: 0, dy: 2 }, { dx: 0, dy: -2 }, { dx: 2, dy: 0 }, { dx: -2, dy: 0 },
  { dx: 1, dy: 2 }, { dx: -1, dy: 2 }, { dx: 1, dy: -2 }, { dx: -1, dy: -2 },
  { dx: 2, dy: 1 }, { dx: -2, dy: 1 }, { dx: 2, dy: -1 }, { dx: -2, dy: -1 },
  { dx: 0, dy: 3 }, { dx: 0, dy: -3 }, { dx: 2, dy: 2 }, { dx: -2, dy: 2 },
];

function dotCenter(d: PlacedDevice) {
  const room = ROOMS.find((r) => r.id === (d.room as RoomId)) ?? ROOMS[0]!;
  return { left: room.x + (d.x / 100) * room.w, top: room.y + (d.y / 100) * room.h };
}

// The plan clips (overflow-hidden for the rounded frame): keep each dot's centre
// far enough from the edge that its pill, ring and shadow stay fully visible.
const EDGE_X_PX = DOT_W_PX / 2 + 8;
const EDGE_Y_PX = DOT_H_PX / 2 + 8;
const edgeClamp = (pct: number, deltaPx: number, edgePx: number) =>
  `clamp(${edgePx}px, calc(${pct}% + ${deltaPx}px), calc(100% - ${edgePx}px))`;

// Walk dots in a fixed order (top-left first, id as tie-break); a dot whose
// pill would overlap an already-placed one takes the nearest free slot around
// its true position that stays inside the plan, or the least-crowded one when
// the room is denser than the plan can show. Deterministic, so a re-render
// never moves a dot that did not need moving.
function collisionOffsets(devices: PlacedDevice[], plan: { w: number; h: number }): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  if (plan.w === 0 || plan.h === 0) return out;
  const placed: Array<{ x: number; y: number }> = [];
  const sorted = devices
    .map((d) => ({ id: d.id, ...dotCenter(d) }))
    .sort((a, b) => a.top - b.top || a.left - b.left || a.id.localeCompare(b.id));
  const crowding = (x: number, y: number) =>
    placed.reduce((acc, p) => {
      const ox = DOT_W_PX - Math.abs(p.x - x);
      const oy = DOT_H_PX - Math.abs(p.y - y);
      return ox > 0 && oy > 0 ? acc + ox * oy : acc;
    }, 0);
  const inside = (x: number, y: number) => x >= DOT_W_PX / 2 && x <= plan.w - DOT_W_PX / 2 && y >= DOT_H_PX / 2 && y <= plan.h - DOT_H_PX / 2;
  for (const d of sorted) {
    const x0 = (d.left / 100) * plan.w;
    const y0 = (d.top / 100) * plan.h;
    let best = { dx: 0, dy: 0, score: crowding(x0, y0) };
    if (best.score > 0) {
      for (const s of SLOTS) {
        const dx = s.dx * DOT_W_PX;
        const dy = s.dy * DOT_H_PX;
        if (!inside(x0 + dx, y0 + dy)) continue;
        const score = crowding(x0 + dx, y0 + dy);
        if (score < best.score) best = { dx, dy, score };
        if (score === 0) break;
      }
    }
    placed.push({ x: x0 + best.dx, y: y0 + best.dy });
    if (best.dx !== 0 || best.dy !== 0) out.set(d.id, { dx: best.dx, dy: best.dy });
  }
  return out;
}

function Room({ room, devices }: { room: (typeof ROOMS)[number]; devices: PlacedDevice[] }) {
  const t = useTranslations("homeCards.floorPlan.rooms");
  // Room tint = blend of the lights that are on inside it; that is what a
  // room actually looks like from the doorway.
  const lit = devices.filter((d) => d.kind === "light" || d.kind === "strip" || d.kind === "projector");
  return (
    <div
      className="absolute rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--color-fg)_14%,transparent)] bg-[color-mix(in_oklch,var(--color-surface)_55%,transparent)]"
      style={{ left: `${room.x}%`, top: `${room.y}%`, width: `${room.w}%`, height: `${room.h}%` }}
    >
      <RoomTint devices={lit} />
      <span className="absolute left-1.5 top-1 hidden max-w-[calc(100%-0.75rem)] truncate text-2xs font-medium text-fg-muted sm:block" title={t(room.id)}>{t(room.id)}</span>
    </div>
  );
}

function RoomTint({ devices }: { devices: PlacedDevice[] }) {
  return (
    <>
      {devices.map((d) => (
        <LightGlow key={d.id} device={d} />
      ))}
    </>
  );
}

function LightGlow({ device }: { device: PlacedDevice }) {
  const s = useEntity(device.entity);
  const color = device.entity ? cssColor(s) : device.id === "dxlight" ? "var(--color-accent)" : null;
  if (!color) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute opacity-[0.65]"
      style={{
        left: `${device.x}%`,
        top: `${device.y}%`,
        width: device.kind === "strip" ? "55%" : "38%",
        height: device.kind === "strip" ? "55%" : "38%",
        translate: "-50% -50%",
      }}
    >
      {/* glow-breathe animates opacity 0.55-0.85 and scale: the wrapper caps the peak at ~0.55 and keeps the centring */}
      <span
        className="absolute inset-0 rounded-full opacity-85 blur-2xl motion-safe:animate-[glow-breathe_4s_ease-in-out_infinite]"
        style={{ background: `color-mix(in oklch, ${color} 60%, var(--color-lit))` }}
      />
    </span>
  );
}

/** Below sm the plan is too small for room labels: list each room with how many of its devices are on. */
function RoomLegend({ devices }: { devices: PlacedDevice[] }) {
  const t = useTranslations("homeCards.floorPlan");
  const roomName = useTranslations("homeCards.floorPlan.rooms");
  const { states } = useHomeStates();
  const deviceOn = (d: PlacedDevice) => (d.entity ? isOn(states[d.entity]) : d.id === "dxlight" || d.id === "pc");
  return (
    <ul aria-label={t("legend")} className="grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2 sm:hidden">
      {ROOMS.map((room) => {
        const list = devices.filter((d) => d.room === room.id);
        const on = list.filter(deviceOn).length;
        return (
          <li key={room.id} className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-sm">
            <span className="min-w-0 truncate font-medium" title={roomName(room.id)}>{roomName(room.id)}</span>
            <span className={cn("shrink-0 text-xs tabular-nums", on > 0 ? "text-lit-text" : "text-fg-muted")} title={t("legendTotal", { n: list.length })}>
              {t("legendOn", { n: on })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DeviceDot({
  device,
  selected,
  arrange,
  offset,
  onSelect,
  onDrop,
  onNudge,
}: {
  device: PlacedDevice;
  selected: boolean;
  arrange: boolean;
  offset: { dx: number; dy: number };
  onSelect: () => void;
  onDrop: (clientX: number, clientY: number) => void;
  onNudge: (dx: number, dy: number) => void;
}) {
  const t = useTranslations("homeCards.floorPlan");
  const { left, top } = dotCenter(device);
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  // Drag offset is reset on drop: the new left/top already carries the move.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const s = useEntity(device.entity);
  const on = device.entity ? isOn(s) : device.id === "dxlight" || device.id === "pc";
  const color = cssColor(s);
  const Icon = KIND_ICON[device.kind];
  const value =
    device.kind === "sensor" && s ? `${Number(s.state).toFixed(1)}°` : device.kind === "ac" && s && s.state !== "off" ? `${s.attributes.temperature ?? ""}°` : null;
  const showLabel = hover || focus || selected;
  // Near the top edge the label would leave the plan (overflow-hidden): show it below the dot instead.
  const below = top < 15;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!arrange) return;
    const step = e.shiftKey ? 5 : 1;
    const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    onNudge(d[0]!, d[1]!);
  };

  return (
    // The wrapper owns centring (translate); the inner motion button owns drag/tap transforms.
    <span
      className={cn("absolute -translate-x-1/2 -translate-y-1/2", showLabel ? "z-20" : "z-10")}
      style={{
        left: edgeClamp(left, offset.dx, EDGE_X_PX),
        top: edgeClamp(top, offset.dy, EDGE_Y_PX),
      }}
    >
      <m.button
        type="button"
        layoutId={arrange ? undefined : deviceLayoutId("dot", device.id)}
        drag={arrange}
        dragMomentum={false}
        dragElastic={0}
        style={{ x, y }}
        onDragEnd={(_, info) => {
          onDrop(info.point.x, info.point.y);
          x.set(0);
          y.set(0);
        }}
        onClick={() => !arrange && onSelect()}
        onKeyDown={onKeyDown}
        onHoverStart={() => setHover(true)}
        onHoverEnd={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        aria-label={`${device.name}${s ? `, ${s.state}` : ""}`}
        aria-pressed={arrange ? undefined : selected}
        aria-describedby={arrange ? "floor-plan-hint" : undefined}
        aria-roledescription={arrange ? t("movable") : undefined}
        title={device.name}
        className={cn(
          "relative flex items-center gap-1 rounded-full border px-1.5 py-1 shadow-md backdrop-blur-md transition-colors",
          FOCUS,
          arrange ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          // selected = border; keyboard focus = the separate outline above
          selected
            ? "border-primary bg-surface"
            : "border-[color-mix(in_oklch,var(--color-fg)_16%,transparent)] bg-[color-mix(in_oklch,var(--color-surface)_88%,transparent)] hover:border-primary",
        )}
      >
        {showLabel && (
          <span
            aria-hidden
            title={device.name}
            className={cn(
              "pointer-events-none absolute left-1/2 max-w-[10rem] -translate-x-1/2 truncate rounded-sm bg-surface px-1.5 py-0.5 text-2xs shadow",
              below ? "top-full mt-1.5" : "bottom-full mb-1.5",
            )}
          >
            {device.name}
          </span>
        )}
        <span
          className={cn("grid size-6 place-items-center rounded-full transition-colors sm:size-7", on ? "text-lit-fg" : "bg-bg-muted text-muted")}
          // the "on" disc takes the bulb's own colour (data); other devices that are on use the lit token
          style={on ? { background: color ?? "var(--color-lit)" } : undefined}
        >
          <Icon className="size-3.5" strokeWidth={2.2} aria-hidden />
        </span>
        {value && <span className="pr-1 text-xs font-medium tabular-nums">{value}</span>}
      </m.button>
    </span>
  );
}
