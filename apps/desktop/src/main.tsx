import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter-tight/wght.css";
import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { App } from "./App";
import { initI18n } from "./i18n";
import { reducedMotion, setWindowVisible } from "./lib";
import { FALLBACK_INFO, type AppInfo } from "./platform";
import { initTheme } from "./theme";
import { ErrorBoundary } from "./ui";

initTheme();

// `?mock=1` in a plain browser (vite dev) answers invoke() from src/mock.ts so the pages can be
// exercised with Playwright without a Tauri window. Never part of a production bundle (DK-34).
const wantsMock = import.meta.env.DEV && new URLSearchParams(location.search).has("mock") && !("__TAURI_INTERNALS__" in window);

async function boot() {
  if (wantsMock) await import("./mock");
  // independent IPC in parallel (was lang_get -> chunk -> render -> app_info, DK-04)
  const [lang, info] = await Promise.all([
    invoke<string>("lang_get").catch(() => null),
    invoke<AppInfo>("app_info").catch(() => FALLBACK_INFO),
  ]);
  await initI18n(lang);
  const renderAt = performance.now();
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary scope="root">
        <App info={info} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  // two frames = React committed and the browser painted it
  requestAnimationFrame(() => requestAnimationFrame(() => void ready(renderAt)));
}

async function ready(renderAt: number) {
  const coldStartMs = performance.now();
  // shown=false: `--hidden` logon start (window stays in the tray) or no Tauri at all
  const shown = await invoke<boolean>("app_ready", { coldStartMs, renderMs: coldStartMs - renderAt }).catch(() => !("__TAURI_INTERNALS__" in window) || wantsMock);
  if (!shown) setWindowVisible(false);
  morphSplash(shown);
}

/** Splash mark -> title-bar mark (FLIP), then fade the splash out. Instant when hidden or reduced motion. */
function morphSplash(animate: boolean) {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const mark = splash.querySelector<SVGSVGElement>(".vt-mark");
  const target = document.querySelector<SVGSVGElement>("[data-brand-mark]");
  if (!animate || reducedMotion() || !mark || !target) return splash.remove();
  const from = mark.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const ease = "cubic-bezier(0.2, 0, 0, 1)"; // --ease-emphasized
  target.style.opacity = "0";
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = to.width / from.width;
  const a = mark.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }], { duration: 420, easing: ease, fill: "forwards" });
  splash.animate([{ backgroundColor: getComputedStyle(splash).backgroundColor }, { backgroundColor: "transparent" }], { duration: 420, easing: ease, fill: "forwards" });
  splash.querySelector(".vt-progress")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: "forwards" });
  const done = () => { target.style.opacity = ""; splash.remove(); };
  a.onfinish = done;
  a.oncancel = done;
}

void boot();
