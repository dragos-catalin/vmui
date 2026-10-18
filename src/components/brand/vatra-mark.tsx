import { cn } from "@/lib/utils";
import { VATRA_GEOMETRY, opticalSizeFor, type VatraOpticalSize } from "./vatra-geometry";

export type VatraMarkState = "static" | "intro" | "thinking" | "success" | "error" | "idle";

export interface VatraMarkProps {
  /** Rendered size in px (picks the optical size: micro <=20, small <=48, master). */
  size?: number;
  /** Force an optical size instead of deriving it from `size`. */
  optical?: VatraOpticalSize;
  state?: VatraMarkState;
  /** Adds the hover puff + press scale. */
  interactive?: boolean;
  /** Accessible name; omit for decorative use (aria-hidden). */
  label?: string;
  className?: string;
}

/**
 * The Vatra mark: house with chimney, hearth flame and rising smoke.
 * Geometry comes from brand/scripts/mark.mjs; motion from vatra-motion.css (`.vt-mark[data-state]`).
 * Colours follow tokens: line = currentColor, flame = --color-primary, core = --color-lit.
 */
export function VatraMark({ size = 24, optical, state = "static", interactive = false, label, className }: VatraMarkProps) {
  const os = optical ?? opticalSizeFor(size);
  const g = VATRA_GEOMETRY[os];
  const b = g.bbox;
  // Same fit as the generator: centred on the house axis, bbox height into the box with a 1-unit margin.
  const k = Math.min(46 / (b.y1 - b.y0), 46 / (2 * Math.max(24 - b.x0, b.x1 - 24)));
  const tx = Math.min(24 - 24 * k, 47 - b.x1 * k);
  const ty = 1 + (46 - (b.y1 - b.y0) * k) / 2 - b.y0 * k - 0.92;
  const op = os === "micro" ? [1] : [0.95, 0.7, 0.45];
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={cn("vt-mark shrink-0", interactive && "vt-interactive", className)}
      data-state={state === "static" ? undefined : state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})`}>
        <path className="vt-roof" pathLength={100} d={g.roof} fill="none" stroke="currentColor" strokeWidth={g.stroke} strokeLinecap="round" strokeLinejoin="round" />
        <path className="vt-walls" pathLength={100} d={g.walls} fill="none" stroke="currentColor" strokeWidth={g.stroke} strokeLinecap="round" strokeLinejoin="round" />
        <path className="vt-flame" d={g.flame} fill="var(--color-primary)" />
        {g.core ? <path className="vt-core" d={g.core} fill="var(--color-lit)" /> : null}
        {g.puffs.map((p, i) => (
          <circle key={i} className={`vt-puff vt-p${i + 1}`} cx={p.cx} cy={p.cy} r={p.r} fill="currentColor" fillOpacity={op[i] ?? 0.45} />
        ))}
      </g>
    </svg>
  );
}
