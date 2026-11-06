/** Appliance profiles: which API path prefixes a hardware token may call. Client-safe (no server imports).
 *  A paired app (phone/desktop) has no scopes = every token route, gated by its member's rooms. */
export const APPLIANCE_PROFILES = {
  esp32: ["/api/esp/display/", "/api/esp/watchdog/", "/api/esp/intercom", "/api/esp/button"],
  deskButton: ["/api/esp/button", "/api/nutrition/water"],
  nestHub: ["/api/display/state", "/api/display/probe", "/api/hub/state", "/api/home/events"],
  turzx: ["/api/turzx/", "/api/nutrition/today", "/api/copilot/event"],
  homeAssistant: ["/api/pc/wake", "/api/desktop/pc", "/api/hooks/contact", "/api/hub/state", "/api/esp/intercom"],
  pcAgent: ["/api/desktop/pc", "/api/turzx/pc", "/api/turzx/mirror", "/api/copilot/event"],
} as const satisfies Record<string, readonly string[]>;

export type ApplianceProfile = keyof typeof APPLIANCE_PROFILES;
export const APPLIANCE_PROFILE_IDS = Object.keys(APPLIANCE_PROFILES) as ApplianceProfile[];

/** Prefix match on path segments: "/api/esp/button" allows "/api/esp/button" and "/api/esp/button/x", never "/api/esp/buttonx". */
export function pathInScopes(path: string, scopes: readonly string[]): boolean {
  return scopes.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s || path.startsWith(`${s}/`)));
}

export function parseScopes(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    // malformed stored scopes fail closed: an empty list allows nothing
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  } catch {
    return [];
  }
}
