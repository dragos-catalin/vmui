"use client";

import { toResult } from "@/components/settings/adapt";
import { useAction, type UseActionOptions } from "@/hooks/use-action";

type LegacyResult = { ok: boolean; error?: string | null };

/** `useAction` for the home actions, which still return `{ ok, error }`.
 *  Device toggles patch the live store optimistically, so no router refresh
 *  by default; pass `refresh: true` when server-rendered data changed. */
export function useHomeAction<A extends unknown[]>(fn: (...args: A) => Promise<LegacyResult>, opts: UseActionOptions<void> = {}) {
  return useAction<A, void>(async (...args: A) => toResult(await fn(...args)), { refresh: false, ...opts });
}
