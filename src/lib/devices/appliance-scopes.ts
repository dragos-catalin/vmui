import profiles from "./appliance-profiles.json";

/** Appliance profiles: which paths a hardware token may call. Client-safe (no server imports).
 *  Kept in JSON so scripts/appliance-tokens.mjs (run on the hub) mints the same scopes.
 *  A paired app (phone/desktop) has no scopes = every token route, gated by its member's rooms. */
export const APPLIANCE_PROFILES = profiles satisfies Record<string, readonly string[]>;

export type ApplianceProfile = keyof typeof APPLIANCE_PROFILES;
export const APPLIANCE_PROFILE_IDS = Object.keys(APPLIANCE_PROFILES) as ApplianceProfile[];

/** credentials.env key holding a profile's provisioned token: deskButton -> VATRA_TOKEN_DESK_BUTTON (same rule in scripts/appliance-tokens.mjs). */
export const applianceEnvKey = (p: ApplianceProfile): string => `VATRA_TOKEN_${p.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;

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
