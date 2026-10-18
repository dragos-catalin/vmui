import type { Locale } from "./config";

// One JSON per namespace per locale under messages/<ns>/<locale>.json, merged
// here. Namespaces are owned by one surface each so parallel work never edits
// the same file; `messages/<locale>.json` holds the shared `nav` / `common` /
// `home` roots. Adding a namespace = add the file pair and list it here (and in
// global.d.ts so keys stay type-checked).
export const NAMESPACES = ["homeCards", "notify", "nutrition", "ambilight", "turzx", "nestHub", "devices", "family", "shell", "appearance", "vm", "dashboard", "settings", "auth", "misc", "cloud", "ops", "observe", "govern", "extras", "lights"] as const;

export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const root = (await import(`../../messages/${locale}.json`)).default as Record<string, unknown>;
  const parts = await Promise.all(
    NAMESPACES.map(async (ns) => {
      try {
        return { [ns]: (await import(`../../messages/${ns}/${locale}.json`)).default as Record<string, unknown> };
      } catch {
        return {};
      }
    }),
  );
  return Object.assign({}, root, ...parts);
}
