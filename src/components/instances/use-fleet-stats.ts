"use client";

import { usePageVisible } from "@/hooks/use-poll";
import type { InstanceStatsSample } from "@/lib/providers/types";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { StatsHistory } from "./use-instance-stats";

const HISTORY_LEN = 60;
const INTERVAL_MS = 5_000;

// Every card that is on screen registers its id; all of them share ONE query
// keyed by the sorted id set, so N running cards cost one request per tick
// instead of N EventSource connections (HTTP/1.1 caps a host at 6).
const refs = new Map<string, number>();
let snapshot = "";
const listeners = new Set<() => void>();

function emit() {
  snapshot = [...refs.keys()].sort().join(",");
  for (const l of listeners) l();
}

function register(id: string): () => void {
  refs.set(id, (refs.get(id) ?? 0) + 1);
  emit();
  return () => {
    const n = (refs.get(id) ?? 1) - 1;
    if (n <= 0) refs.delete(id);
    else refs.set(id, n);
    emit();
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const histories = new Map<string, StatsHistory>();
const EMPTY: StatsHistory = { cpu: [], mem: [], diskR: [], diskW: [], netRx: [], netTx: [] };

function push(arr: number[], v: number): number[] {
  const next = arr.length >= HISTORY_LEN ? arr.slice(arr.length - HISTORY_LEN + 1) : arr.slice();
  next.push(v);
  return next;
}

function record(id: string, s: InstanceStatsSample) {
  const h = histories.get(id) ?? EMPTY;
  const mem = s.memUsedBytes && s.memTotalBytes ? Math.min(100, (s.memUsedBytes / s.memTotalBytes) * 100) : 0;
  histories.set(id, {
    cpu: push(h.cpu, Math.min(100, Math.max(0, s.cpuPercent ?? 0))),
    mem: push(h.mem, mem),
    diskR: push(h.diskR, s.diskReadBps ?? 0),
    diskW: push(h.diskW, s.diskWriteBps ?? 0),
    netRx: push(h.netRx, s.netRxBps ?? 0),
    netTx: push(h.netTx, s.netTxBps ?? 0),
  });
}

type Samples = Record<string, InstanceStatsSample | null>;
const lastSampledAt = new Map<string, number>();

async function fetchFleet(ids: string): Promise<Samples> {
  const r = await fetch(`/api/instances/stats?ids=${encodeURIComponent(ids)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  const { samples } = (await r.json()) as { samples: Samples };
  for (const [id, s] of Object.entries(samples)) {
    if (!s || lastSampledAt.get(id) === s.sampledAt) continue;
    lastSampledAt.set(id, s.sampledAt);
    record(id, s);
  }
  return samples;
}

/** Latest sample + rolling history for one instance, from the shared fleet
 *  poll. Pass `active=false` while the card is off-screen. */
export function useFleetStats(instanceId: string, active: boolean): { latest: InstanceStatsSample | null; history: StatsHistory } {
  const visible = usePageVisible();
  const on = active && visible;
  React.useEffect(() => (on ? register(instanceId) : undefined), [on, instanceId]);
  const ids = React.useSyncExternalStore(subscribe, () => snapshot, () => "");
  const q = useQuery({
    queryKey: ["fleet-stats", ids],
    queryFn: () => fetchFleet(ids),
    enabled: on && ids !== "",
    refetchInterval: INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: INTERVAL_MS - 1000,
    structuralSharing: false,
    placeholderData: (prev) => prev,
  });
  return { latest: q.data?.[instanceId] ?? null, history: histories.get(instanceId) ?? EMPTY };
}
