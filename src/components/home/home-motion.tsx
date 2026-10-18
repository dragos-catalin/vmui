"use client";

import { SkeletonCard } from "@/components/ui/skeleton";
import * as m from "motion/react-m";
import * as React from "react";

/** BRIEF motion language: base 220 ms, ease-out enter, 8 px rise. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const SPRING = { type: "spring", stiffness: 380, damping: 32 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 220, damping: 28 } as const;

/** Shared-element ids: a tile/dot and the device sheet header morph into each other. */
export type DeviceOrigin = "tile" | "dot";
export const deviceLayoutId = (origin: DeviceOrigin, id: string) => `home-device-${origin}-${id}`;

/** Skeleton → content crossfade for lazily loaded tab bodies (HM-49). */
export function withFade<P extends object>(C: React.ComponentType<P>) {
  function Faded(props: P) {
    return (
      <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22, ease: EASE_OUT }} className="min-w-0">
        <C {...props} />
      </m.div>
    );
  }
  Faded.displayName = `Faded(${C.displayName ?? C.name ?? "Component"})`;
  return Faded;
}

export function TabSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="space-y-4" aria-hidden>
      {Array.from({ length: cards }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
