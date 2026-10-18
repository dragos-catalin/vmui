"use client";

import { Skeleton } from "@/components/ui";
import dynamic from "next/dynamic";

/** xterm + its CSS only load when a terminal actually opens. */
export const TerminalView = dynamic(() => import("./terminal-view").then((mod) => mod.TerminalView), {
  ssr: false,
  loading: () => <Skeleton className="h-[60vh] min-h-80 w-full rounded-[var(--radius-md)]" />,
});
