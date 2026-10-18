import * as React from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

// `?mock=1` in a plain browser (vite dev) answers invoke() from src/mock.ts so
// the pages can be exercised with Playwright without a Tauri window.
const boot = new URLSearchParams(location.search).has("mock") && !("__TAURI_INTERNALS__" in window) ? import("./mock") : Promise.resolve();
void boot.then(() => import("./i18n")).then((m) => m.initI18n()).then(() => import("./App")).then(({ App }) =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
