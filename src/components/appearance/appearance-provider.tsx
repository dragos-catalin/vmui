"use client";

import { APPEARANCE_COOKIE, APPEARANCE_STORAGE_KEY, VIBE_PRESET, appearanceAttributes, parseAppearance, type Appearance, type Vibe } from "@/lib/appearance/model";
import { saveAppearanceAction } from "@/server/actions/appearance";
import { LazyMotion, MotionConfig } from "motion/react";

const loadMotionFeatures = () => import("./motion-features").then((mod) => mod.default);
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import * as React from "react";

type Ctx = {
  appearance: Appearance;
  /** Patch any axis; persists to cookie + localStorage immediately and to the user's row (debounced). */
  update: (patch: Partial<Appearance>) => void;
  /** Apply a vibe preset (accent + surface + atmosphere together). */
  applyVibe: (v: Vibe) => void;
  ready: boolean;
};

const AppearanceCtx = React.createContext<Ctx | null>(null);

function applyToDocument(a: Appearance) {
  const el = document.documentElement;
  const attrs = appearanceAttributes(a);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") el.style.setProperty("--accent-h", String(v).split(":")[1] ?? "48");
    else el.setAttribute(k, v);
  }
  if (a.reducedMotion === null) el.removeAttribute("data-motion");
  if (!a.ambient) el.removeAttribute("data-ambient");
}

function persistLocally(a: Appearance) {
  const json = JSON.stringify(a);
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, json);
  } catch {
    /* storage blocked */
  }
  document.cookie = `${APPEARANCE_COOKIE}=${encodeURIComponent(json)}; path=/; max-age=31536000; samesite=lax`;
}

/** Bridges our `theme` axis to next-themes so the `.dark` class and OS preference keep working. */
function ThemeBridge({ theme }: { theme: Appearance["theme"] }) {
  const { theme: current, setTheme } = useTheme();
  React.useEffect(() => {
    if (current !== theme) setTheme(theme);
  }, [theme, current, setTheme]);
  return null;
}

export function AppearanceProvider({ initial, children }: { initial: Appearance; children: React.ReactNode }) {
  const [appearance, setAppearance] = React.useState<Appearance>(initial);
  const [ready, setReady] = React.useState(false);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    // The server already rendered the cookie's value; localStorage only wins when the cookie was missing.
    if (!document.cookie.includes(`${APPEARANCE_COOKIE}=`)) {
      try {
        const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
        if (stored) setAppearance(parseAppearance(stored));
      } catch {
        /* ignore */
      }
    }
    setReady(true);
  }, []);

  React.useEffect(() => {
    if (!ready) return;
    applyToDocument(appearance);
    persistLocally(appearance);
  }, [appearance, ready]);

  const update = React.useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => {
      const next = parseAppearance({ ...prev, ...patch });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveAppearanceAction(next).catch(() => undefined), 600);
      return next;
    });
  }, []);

  const applyVibe = React.useCallback((v: Vibe) => update({ vibe: v, ...VIBE_PRESET[v] }), [update]);

  const value = React.useMemo<Ctx>(() => ({ appearance, update, applyVibe, ready }), [appearance, update, applyVibe, ready]);
  // JS animations follow the same switch as CSS: explicit in-app setting wins, else the OS preference.
  const reducedMotion = appearance.reducedMotion === null ? "user" : appearance.reducedMotion ? "always" : "never";
  return (
    <NextThemesProvider attribute="class" defaultTheme={initial.theme} enableSystem disableTransitionOnChange>
      <ThemeBridge theme={appearance.theme} />
      <AppearanceCtx.Provider value={value}>
        <LazyMotion features={loadMotionFeatures}>
          <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
        </LazyMotion>
      </AppearanceCtx.Provider>
    </NextThemesProvider>
  );
}

export function useAppearance(): Ctx {
  const ctx = React.useContext(AppearanceCtx);
  if (!ctx) throw new Error("useAppearance outside AppearanceProvider");
  return ctx;
}

/** Back-compat shape for the few components that only care about the vibe (hero canvas, switcher). */
export function useVibe(): { vibe: Vibe; setVibe: (v: Vibe) => void; ready: boolean } {
  const { appearance, applyVibe, ready } = useAppearance();
  return { vibe: appearance.vibe, setVibe: applyVibe, ready };
}
