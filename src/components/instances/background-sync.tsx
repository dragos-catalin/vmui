"use client";

import { useInterval } from "@/hooks/use-poll";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncAllAccounts } from "@/server/actions/instances";

/**
 * Mounts on the dashboard and syncs all accounts every 15 s while the tab is
 * visible (useInterval pauses when hidden) to save provider API calls.
 */
export function BackgroundSync({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const inFlight = useRef(false);

  const tick = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    start(async () => {
      try {
        await syncAllAccounts();
        router.refresh();
      } catch {
        /* ignore — surfaced elsewhere */
      } finally {
        inFlight.current = false;
      }
    });
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useInterval(tick, enabled ? 15_000 : null);
  useEffect(() => {
    if (!enabled) return;
    const k = setTimeout(() => tickRef.current(), 1_000);
    return () => clearTimeout(k);
  }, [enabled]);

  return null;
}
