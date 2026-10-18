"use client";

import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import * as React from "react";
import { VatraMark } from "./vatra-mark";

const KEY = "vatra:splash";

/**
 * Cold-start splash: plays the logo intro once per browser session (and on PWA launch),
 * then the mark morphs into the sidebar brand (shared layoutId "vatra-brand-mark").
 * Never on client navigations. Server-rendered in every shell response but `display:none` unless
 * the render-blocking boot script put `data-splash` on <html> (CSS in globals.css). The page paints
 * underneath, so LCP is not delayed; the overlay only covers it. Without JS a CSS failsafe fades it.
 */
export function Splash({ label }: { label: string }) {
  const [show, setShow] = React.useState(true);

  React.useEffect(() => {
    const html = document.documentElement;
    if (!html.hasAttribute("data-splash")) {
      setShow(false);
      return;
    }
    const reduce = html.dataset.motion === "reduce" || (html.dataset.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    // The CSS exit starts 800 ms after first paint. Hydrated in time -> hand the mark to the
    // sidebar (layoutId morph) just before it; hydrated late -> the overlay is already gone.
    const left = 760 - performance.now();
    const t = setTimeout(() => setShow(false), reduce || left <= 0 ? 0 : left);
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* storage blocked: the splash simply shows again next load */
    }
    return () => clearTimeout(t);
  }, []);

  return (
    <AnimatePresence initial={false} onExitComplete={() => document.documentElement.removeAttribute("data-splash")}>
      {show ? (
        <m.div
          key="splash"
          className="vatra-splash fixed inset-0 z-[var(--z-splash)] place-items-center bg-bg"
          exit={{ opacity: 0, transition: { duration: 0.32, ease: [0.65, 0, 0.35, 1] } }}
          role="status"
          aria-label={label}
        >
          <m.span layoutId="vatra-brand-mark" className="grid place-items-center text-fg" transition={{ type: "spring", stiffness: 220, damping: 28 }}>
            <VatraMark size={112} state="intro" />
          </m.span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Inline, render-blocking: decides before first paint whether this load gets the splash. */
export const SPLASH_BOOT_SCRIPT = `try{if(!sessionStorage.getItem("${KEY}"))document.documentElement.setAttribute("data-splash","")}catch(e){}`;
