"use client";

import { MorphSurface } from "@/components/instances/instance-hero";
import type { ReactNode } from "react";

/** Shared-element name for one account: grid card / table row ↔ detail hero. */
export function accountMorphName(id: string): string {
  return `acct-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function AccountHero({ accountId, children }: { accountId: string; children: ReactNode }) {
  return (
    <MorphSurface name={accountMorphName(accountId)} className="min-w-0">
      {children}
    </MorphSurface>
  );
}
