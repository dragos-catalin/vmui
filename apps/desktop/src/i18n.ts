import { invoke } from "@tauri-apps/api/core";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { setSwatchTranslator } from "./lights";
import en from "./locales/en.json";
import ro from "./locales/ro.json";

export type Lang = "ro" | "en";
export const LANGS: Lang[] = ["ro", "en"];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof ro };
  }
}

/** Language comes from Rust (app data lang.txt, shared with the tray); "ro" when unavailable.
 *  `saved` lets main.tsx fetch it in parallel with app_info. */
export async function initI18n(saved?: string | null) {
  if (saved === undefined) saved = await invoke<string>("lang_get").catch(() => null);
  const lng: Lang = saved === "en" ? "en" : "ro";
  await i18n.use(initReactI18next).init({
    resources: { ro: { translation: ro }, en: { translation: en } },
    lng,
    fallbackLng: "ro",
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = lng;
  setSwatchTranslator((k, f) => tx(k, f));
}

/** Persist in Rust (rebuilds the tray labels) and switch the UI even if persisting failed. */
export async function setLanguage(lng: Lang) {
  try {
    await invoke("lang_set", { lang: lng });
  } finally {
    await i18n.changeLanguage(lng);
    document.documentElement.lang = lng;
  }
}

export const currentLocale = () => (i18n.language === "en" ? "en-GB" : "ro-RO");

/** For keys built at runtime (room ids, kinds); returns `fallback` when the key is missing. */
export function tx(key: string, fallback?: string, opts?: Record<string, unknown>): string {
  return i18n.exists(key) ? (i18n.t(key as never, opts as never) as unknown as string) : (fallback ?? key);
}

export default i18n;
