import * as React from "react";

export type ThemePref = "system" | "dark" | "light";
const KEY = "vatra:theme";
const mq = () => window.matchMedia("(prefers-color-scheme: light)");

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "dark" || v === "light" ? v : "system";
}

/** `.dark` on <html> (the app is dark-first; "system" follows the OS). */
export function applyTheme(pref: ThemePref = getThemePref()) {
  const dark = pref === "dark" || (pref === "system" && !mq().matches);
  document.documentElement.classList.toggle("dark", dark);
}

const subs = new Set<() => void>();
export function setThemePref(pref: ThemePref) {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  applyTheme(pref);
  subs.forEach((s) => s());
}

/** Call once at boot: applies the stored preference and follows OS changes while on "system". */
export function initTheme() {
  applyTheme();
  mq().addEventListener("change", () => getThemePref() === "system" && applyTheme("system"));
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const pref = React.useSyncExternalStore((cb) => { subs.add(cb); return () => void subs.delete(cb); }, getThemePref, () => "system" as ThemePref);
  return [pref, setThemePref];
}
