export const HOME_TABS = ["home", "ambilight", "notifications", "nutrition", "settings"] as const;
export type HomeTab = (typeof HOME_TABS)[number];

export const SETTINGS_SECTIONS = ["family", "house", "integrations", "turzx", "nestHub", "deskButton", "copilot"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Old `?tab=` values keep working: bookmarks, the desktop app and HA links use them.
 *  Non-owners have no settings tab; a settings link lands them on the overview. */
export function normalizeHomeTab(v: string | undefined, canManage = true): HomeTab {
  switch (v) {
    case "ambilight":
      return "ambilight";
    case "notifications":
      return "notifications";
    case "nutrition":
      return "nutrition";
    case "settings":
    case "displays":
    case "screens":
    case "devices":
      return canManage ? "settings" : "home";
    default:
      return "home";
  }
}

/** `?section=` inside the settings tab; legacy tabs land on the panel they used to hold. */
export function normalizeSettingsSection(tab: string | undefined, section: string | undefined): SettingsSection {
  if ((SETTINGS_SECTIONS as readonly string[]).includes(section ?? "")) return section as SettingsSection;
  if (tab === "devices") return "deskButton";
  if (tab === "displays" || tab === "screens") return "turzx";
  return "family";
}
