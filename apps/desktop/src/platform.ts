import * as React from "react";
import { api } from "./lib";

/** `dev` = running from the vmui checkout (local stack pages); `paired` = has its own hub token (P9). */
export type AppInfo = { root: string; vmui: string; haUrl: string; displayUrl: string; version: string; mobile?: boolean; dev?: boolean; paired?: boolean };

/** Detected once: Android/iOS webview UA, or the Rust side says so. */
export const isMobileUA = /Android|iPhone|iPad/i.test(navigator.userAgent);

const Ctx = React.createContext<AppInfo | null>(null);
export const PlatformProvider = Ctx.Provider;
export function usePlatform(): AppInfo & { mobile: boolean; dev: boolean } {
  const i = React.useContext(Ctx);
  return { root: "", vmui: "", haUrl: "", displayUrl: "", version: "", ...(i ?? {}), mobile: i?.mobile ?? isMobileUA, dev: !!i?.dev };
}
export const FALLBACK_INFO: AppInfo = { root: "", vmui: "", haUrl: "", displayUrl: "", version: "?", mobile: isMobileUA };

/** `initial` = app_info fetched by main.tsx before the first render (no blank frame). */
export function useAppInfo(initial?: AppInfo | null) {
  const [info, setInfo] = React.useState<AppInfo | null>(initial ?? null);
  const refresh = React.useCallback(() => api.appInfo().then((i) => setInfo(i as AppInfo)).catch(() => setInfo(FALLBACK_INFO)), []);
  React.useEffect(() => { if (!initial) void refresh(); }, [refresh, initial]);
  return { info, refresh };
}
