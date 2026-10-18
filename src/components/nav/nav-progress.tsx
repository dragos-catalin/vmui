"use client";

import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";

export const NAV_START_EVENT = "vatra:navigate-start";
/** Navigations longer than this switch the brand mark to its "thinking" state. */
const SLOW_MS = 400;
/** A navigation that never lands (cancelled, error, same URL) resets after this. */
const RESET_MS = 8000;

/**
 * Call right before a programmatic `router.push`/`replace` (command palette, G-shortcuts, voice) so the
 * progress bar starts; anchor clicks and back/forward are picked up automatically. Pass the target href
 * so a push to the current URL is ignored.
 */
export function startNavProgress(href?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ href?: string }>(NAV_START_EVENT, { detail: { href } }));
}

// Tiny external store: is a slow navigation in flight? Read by the sidebar mark via useIsNavigating().
let navigating = false;
const listeners = new Set<() => void>();
function setNavigating(v: boolean) {
  if (navigating === v) return;
  navigating = v;
  if (v) document.documentElement.dataset.navigating = "";
  else delete document.documentElement.dataset.navigating;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while a client navigation has been pending for more than 400 ms. */
export function useIsNavigating(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => navigating,
    () => false,
  );
}

function samePage(href: string): boolean {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return true;
  return url.pathname + url.search === location.pathname + location.search;
}

/**
 * 2px primary bar at the very top during client navigations. Starts on same-origin anchor clicks to a
 * different path/search, on `startNavProgress()`, and on back/forward; finishes when the pathname or
 * search params change; hash-only changes are ignored; resets itself after 8 s.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = React.useState(false);
  const [width, setWidth] = React.useState(0);
  const timers = React.useRef<{ trickle?: ReturnType<typeof setInterval>; slow?: ReturnType<typeof setTimeout>; reset?: ReturnType<typeof setTimeout>; done?: ReturnType<typeof setTimeout> }>({});
  const activeRef = React.useRef(false);

  const clearAll = React.useCallback(() => {
    const t = timers.current;
    if (t.trickle) clearInterval(t.trickle);
    if (t.slow) clearTimeout(t.slow);
    if (t.reset) clearTimeout(t.reset);
    if (t.done) clearTimeout(t.done);
    timers.current = {};
  }, []);

  const finish = React.useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearAll();
    setNavigating(false);
    setWidth(100);
    timers.current.done = setTimeout(() => {
      setActive(false);
      setWidth(0);
    }, 220);
  }, [clearAll]);

  const start = React.useCallback(() => {
    clearAll();
    activeRef.current = true;
    setActive(true);
    setWidth(12);
    timers.current.trickle = setInterval(() => setWidth((w) => (w < 90 ? w + (90 - w) * 0.12 : w)), 160);
    timers.current.slow = setTimeout(() => setNavigating(true), SLOW_MS);
    timers.current.reset = setTimeout(() => {
      activeRef.current = false;
      clearAll();
      setNavigating(false);
      setActive(false);
      setWidth(0);
    }, RESET_MS);
  }, [clearAll]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      if (samePage(a.href)) return;
      start();
    };
    const onStart = (e: Event) => {
      const href = (e as CustomEvent<{ href?: string }>).detail?.href;
      if (href && samePage(href)) return;
      start();
    };
    const onPop = () => start();
    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener(NAV_START_EVENT, onStart);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener(NAV_START_EVENT, onStart);
      window.removeEventListener("popstate", onPop);
    };
  }, [start]);

  // The URL changed: the navigation landed.
  const key = `${pathname}?${search?.toString() ?? ""}`;
  React.useEffect(() => {
    finish();
  }, [key, finish]);

  React.useEffect(
    () => () => {
      clearAll();
      setNavigating(false);
    },
    [clearAll],
  );

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-splash)] h-0.5">
      <div
        className="h-full bg-primary transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%`, opacity: active ? 1 : 0 }}
      />
    </div>
  );
}
