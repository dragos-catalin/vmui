"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

type Fade = "none" | "left" | "right" | "both";

const MASK: Record<Fade, string | undefined> = {
  none: undefined,
  left: "linear-gradient(to right, transparent, black 2rem)",
  right: "linear-gradient(to left, transparent, black 2rem)",
  both: "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)",
};

/**
 * Horizontal scroller that fades the edge(s) that still hide content, so a cut-off
 * item reads as "more this way". Focusable (tabIndex 0) only while it overflows.
 * `activeSelector` scrolls the matching descendant into view when it changes.
 */
export function ScrollFade({
  children,
  label,
  className,
  innerClassName,
  activeSelector = '[aria-current="page"],[aria-checked="true"],[aria-selected="true"]',
  activeKey,
}: {
  children: React.ReactNode;
  label: string;
  className?: string;
  innerClassName?: string;
  activeSelector?: string;
  /** Change this (e.g. the selected value) to re-centre the active item. */
  activeKey?: unknown;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [fade, setFade] = React.useState<Fade>("none");

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) return setFade("none");
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    setFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
  }, []);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const active = el.querySelector<HTMLElement>(activeSelector);
    if (!active) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: reduce ? "auto" : "smooth" });
  }, [activeKey, activeSelector]);

  const overflowing = fade !== "none";
  const mask = MASK[fade];
  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={overflowing ? 0 : undefined}
      data-fade={fade}
      onScroll={measure}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className={cn(
        "min-w-0 max-w-full overflow-x-auto [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div className={cn("w-max", innerClassName)}>{children}</div>
    </div>
  );
}
