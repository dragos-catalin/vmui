import "server-only";

import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage, type Locale } from "@/i18n/config";
import { NextResponse } from "next/server";
import en from "../../messages/api/en.json";
import ro from "../../messages/api/ro.json";

/**
 * One error contract for the token / device API used by the native apps:
 *   { ok: false, code: "no_room_access", error: "<localised text>" }
 * Clients branch on `code` (stable, English); `error` is for display and follows
 * the device's Accept-Language (or `x-vatra-locale`).
 */
export type ApiErrorCode = keyof typeof en.errors;

const TABLE: Record<Locale, Record<ApiErrorCode, string>> = { en: en.errors, ro: ro.errors };

export function requestLocale(req: Request): Locale {
  const explicit = req.headers.get("x-vatra-locale");
  if (isLocale(explicit)) return explicit;
  return localeFromAcceptLanguage(req.headers.get("accept-language")) ?? DEFAULT_LOCALE;
}

export function apiText(req: Request, code: ApiErrorCode): string {
  return TABLE[requestLocale(req)][code];
}

export function apiError(req: Request, code: ApiErrorCode, status: number): NextResponse {
  return NextResponse.json({ ok: false, code, error: apiText(req, code) }, { status });
}

export const apiForbidden = (req: Request): NextResponse => apiError(req, "forbidden", 403);
