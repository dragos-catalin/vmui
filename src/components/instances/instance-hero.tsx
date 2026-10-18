"use client";

import * as m from "motion/react-m";
import { ViewTransition, type ReactNode } from "react";

/** Shared-element name for one instance: card/row in the list ↔ detail hero. */
export function instanceMorphName(id: string): string {
  return `inst-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Morph surface used on BOTH ends of list → detail. React <ViewTransition>
 * names the element only while a transition runs (so N cards cost nothing and
 * a card + table row never collide); Motion `layoutId` covers in-page moves
 * (grid ↔ table toggle, reorder) where both ends are mounted together.
 */
export function MorphSurface({ name, children, className }: { name: string; children: ReactNode; className?: string }) {
  return (
    <ViewTransition name={name}>
      <m.div layoutId={name} className={className} transition={{ type: "spring", stiffness: 380, damping: 32 }}>
        {children}
      </m.div>
    </ViewTransition>
  );
}

/** Instance detail header wrapper; pairs with the card/row in the list. */
export function InstanceHero({ instanceId, children }: { instanceId: string; children: ReactNode }) {
  return (
    <MorphSurface name={instanceMorphName(instanceId)} className="min-w-0">
      <m.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </m.div>
    </MorphSurface>
  );
}
