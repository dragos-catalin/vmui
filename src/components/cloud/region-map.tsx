import { Stat } from "@/components/ui";

export interface RegionBucketPoint {
  label: string;
  x: number;
  y: number;
  n: number;
}

const W = 900;
const H = 460;

/** Places each bubble label below its circle, flipping it above when it would collide with one already placed. */
function layoutLabels(points: RegionBucketPoint[], max: number) {
  const placed: { x: number; y: number }[] = [];
  return points.map((p) => {
    const r = 8 + Math.sqrt(p.n / max) * 36;
    const below = p.y + r + 14;
    const above = p.y - r - 6;
    const collides = (y: number) => placed.some((q) => Math.abs(q.x - p.x) < 72 && Math.abs(q.y - y) < 14);
    const y = collides(below) ? above : below;
    placed.push({ x: p.x, y });
    return { point: p, r, labelY: y };
  });
}

export function RegionMap({
  points,
  max,
  counts,
  ariaLabel,
}: {
  points: RegionBucketPoint[];
  max: number;
  counts: { label: string; n: number }[];
  ariaLabel: string;
}) {
  return (
    <div className="space-y-4">
      <div className="surface overflow-x-auto p-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] lg:[mask-image:none]">
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${W} ${H}`}
          className="mx-auto block h-auto w-full min-w-[36rem] max-w-[56rem] rounded-[var(--radius-md)]"
        >
          <rect width={W} height={H} fill="var(--color-surface-muted)" />
          <g stroke="var(--color-border)" strokeWidth="0.5" fill="none">
            {Array.from({ length: 7 }, (_, i) => (
              <line key={`h${i}`} x1={0} y1={(H / 6) * i} x2={W} y2={(H / 6) * i} />
            ))}
            {Array.from({ length: 13 }, (_, i) => (
              <line key={`v${i}`} x1={(W / 12) * i} y1={0} x2={(W / 12) * i} y2={H} />
            ))}
          </g>
          {layoutLabels(points, max).map(({ point: p, r, labelY }) => (
              <g key={p.label}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="color-mix(in oklch, var(--color-primary) 25%, transparent)"
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                />
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill="var(--color-fg)" fontWeight={600}>
                  {p.n}
                </text>
                <text x={p.x} y={labelY} textAnchor="middle" fontSize={12} fill="var(--color-fg-muted)">
                  {p.label}
                </text>
              </g>
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {counts.map((c) => (
          <Stat key={c.label} label={c.label} value={c.n} />
        ))}
      </div>
    </div>
  );
}

export { H as REGION_MAP_HEIGHT, W as REGION_MAP_WIDTH };
