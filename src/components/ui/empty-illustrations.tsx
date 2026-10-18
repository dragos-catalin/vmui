"use client";

import * as m from "motion/react-m";
import * as React from "react";

export type EmptyIllustration = "vms" | "lights" | "devices" | "offline" | "search" | "notifications" | "activity" | "costs" | "generic";

/** Smoke puffs: the Vatra mark's signature. They drift up once on mount (MotionConfig turns it off under reduced motion). */
function Puffs({ x, y, delay = 0.25 }: { x: number; y: number; delay?: number }) {
  const puffs = [
    { dx: 0, dy: 0, r: 2.2, o: 0.9 },
    { dx: 3, dy: -6, r: 1.8, o: 0.65 },
    { dx: 0.5, dy: -11.5, r: 1.4, o: 0.4 },
  ];
  return (
    <g>
      {puffs.map((p, i) => (
        <m.circle
          key={i}
          cx={x + p.dx}
          cy={y + p.dy}
          r={p.r}
          fill="currentColor"
          stroke="none"
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: p.o, y: 0 }}
          transition={{ duration: 0.9, delay: delay + i * 0.14, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
    </g>
  );
}

const FLAME = "M0 0c-2.4-2-3.2-4.2-1.6-7 .6 1.4 1.6 1.8 2.2.6.4-1.4.2-2.6 1-3.6 1.6 2.6 2.8 5.2 1.6 7.8C2.6-.8 1.4 0 0 0Z";

function Flame({ x, y, faded = false }: { x: number; y: number; faded?: boolean }) {
  return <path d={FLAME} transform={`translate(${x} ${y})`} fill="var(--color-primary)" stroke="none" opacity={faded ? 0.35 : 0.9} />;
}

/** Roofline with chimney, the base shape every illustration sits under. */
function Roof({ dashed = false }: { dashed?: boolean }) {
  return <path d="M14 38 48 12l12 9.2V14h7v12.6L82 38" strokeDasharray={dashed ? "3 4" : undefined} />;
}

const ART: Record<EmptyIllustration, React.ReactNode> = {
  generic: (
    <>
      <Roof />
      <path d="M22 34v26h52V34" />
      <Flame x={47} y={58} />
      <Puffs x={63.5} y={9} />
    </>
  ),
  vms: (
    <>
      <rect x="26" y="20" width="44" height="12" rx="3" />
      <rect x="26" y="36" width="44" height="12" rx="3" />
      <rect x="26" y="52" width="44" height="12" rx="3" />
      <path d="M32 26h6M32 42h6M32 58h6" />
      <path d="M58 20v-6h6v6" />
      <circle cx="63" cy="26" r="1" fill="var(--color-lit)" stroke="none" />
      <circle cx="63" cy="42" r="1" fill="var(--color-lit)" stroke="none" />
      <Puffs x={61} y={9} />
    </>
  ),
  lights: (
    <>
      <path d="M48 22a13 13 0 0 0-8 23.2c1.6 1.3 2.5 3.1 2.5 5.1V53h11v-2.7c0-2 .9-3.8 2.5-5.1A13 13 0 0 0 48 22Z" />
      <path d="M43 58h10M44.5 62h7" />
      <path d="M45 43c0-3 1.5-4 3-6 1.5 2 3 3 3 6" stroke="var(--color-primary)" />
      <Puffs x={34} y={20} delay={0.2} />
      <Puffs x={62} y={20} delay={0.35} />
    </>
  ),
  devices: (
    <>
      <path d="M12 34 48 8l14 10.1V12h6v10.4L84 34" />
      <rect x="24" y="36" width="30" height="24" rx="3" />
      <rect x="60" y="38" width="13" height="22" rx="3" />
      <path d="M37 56h4M65 56h3" />
      <Puffs x={65} y={7} />
    </>
  ),
  offline: (
    <>
      <Roof dashed />
      <path d="M22 34v26h52V34" opacity={0.7} />
      <Flame x={47} y={58} faded />
      <path d="M40 44l16 0" opacity={0.5} strokeDasharray="2 3" />
    </>
  ),
  search: (
    <>
      <circle cx="42" cy="36" r="16" />
      <path d="M53.5 47.5 66 60" strokeWidth={3} />
      <path d="M62 56v-8h6v14" />
      <Puffs x={65} y={42} />
      <path d="M34 36a8 8 0 0 1 8-8" opacity={0.6} />
    </>
  ),
  notifications: (
    <>
      <path d="M48 16a14 14 0 0 0-14 14v10l-5 8h38l-5-8V30a14 14 0 0 0-14-14Z" />
      <path d="M43 52a5 5 0 0 0 10 0" />
      <Puffs x={68} y={24} />
    </>
  ),
  activity: (
    <>
      <path d="M16 52h64" opacity={0.6} />
      <circle cx="22" cy="52" r="3" />
      <circle cx="40" cy="52" r="3" />
      <circle cx="58" cy="52" r="3" fill="var(--color-primary)" stroke="var(--color-primary)" />
      <path d="M40 49V34M58 49V26" opacity={0.6} />
      <Puffs x={58} y={20} />
    </>
  ),
  costs: (
    <>
      <path d="M16 34 48 10l12 9V12h7v12.2L80 34" />
      <ellipse cx="48" cy="58" rx="13" ry="4" />
      <path d="M35 58v-6c0 2.2 5.8 4 13 4s13-1.8 13-4v6M35 52v-6c0 2.2 5.8 4 13 4s13-1.8 13-4v6" />
      <ellipse cx="48" cy="46" rx="13" ry="4" />
      <Puffs x={63.5} y={7} />
    </>
  ),
};

/** 96x72 line illustration built from the Vatra mark's language: roofline, chimney, flame, smoke. */
export function EmptyArt({ kind, className }: { kind: EmptyIllustration; className?: string }) {
  return (
    <svg
      viewBox="0 0 96 72"
      width={96}
      height={72}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {ART[kind]}
    </svg>
  );
}
