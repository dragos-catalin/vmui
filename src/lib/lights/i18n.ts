import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage, type Locale } from "@/i18n/config";
import "server-only";
import en from "../../../messages/lights/en.json";
import ro from "../../../messages/lights/ro.json";

// Registry errors are thrown as LightError(code, params) and rendered per request
// locale at the edge (HTTP route / MCP). Seeded names are stored as "@<key>" and
// localized on output, so one registry reads right in both languages. Strings use
// only plain {param} placeholders, so lookup + replace is enough.

const MESSAGES: Record<Locale, typeof en> = { en, ro };

export type LightErrorCode = keyof typeof en.errors;

export class LightError extends Error {
  constructor(public code: LightErrorCode, public params: Record<string, string | number> = {}) {
    super(`${code}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`);
    this.name = "LightError";
  }
}

export function lightsLocale(req: Request): Locale {
  const q = new URL(req.url).searchParams.get("lang");
  if (isLocale(q)) return q;
  return localeFromAcceptLanguage(req.headers.get("accept-language")) ?? DEFAULT_LOCALE;
}

function lookup(locale: Locale, key: string): string | undefined {
  let node: unknown = MESSAGES[locale];
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function lightsText(locale: Locale, key: string, params: Record<string, string | number> = {}): string {
  const raw = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key) ?? key;
  return raw.replace(/\{(\w+)\}/g, (m, p: string) => (params[p] !== undefined ? String(params[p]) : m));
}

export function errorText(e: unknown, locale: Locale): string {
  if (e instanceof LightError) return lightsText(locale, `errors.${e.code}`, e.params);
  return e instanceof Error ? e.message : String(e);
}

/** "@profiles.day" -> localized; anything else is a user-chosen name and stays as is. */
export function localizeName(name: string, locale: Locale): string {
  return name.startsWith("@") ? lightsText(locale, name.slice(1)) : name;
}

export function roomName(room: string, locale: Locale): string {
  return lookup(locale, `rooms.${room}`) ?? room;
}
