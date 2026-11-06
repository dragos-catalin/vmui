import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeFromAcceptLanguage, type Locale } from "@/i18n/config";
import { getCurrentUser } from "@/lib/auth";
import { deviceFromRequest } from "@/lib/devices/pairing";
import { espAuthorized } from "@/lib/esp/auth";
import { homeActorFromRequest, type FamilyRole } from "@/lib/home/access";
import "server-only";

/** `userId` = the family member acting (bound device or session); null for the shared desktop token. */
export type NotifyActor = { by: string; deviceId: string | null; userId: string | null; locale: Locale; role: FamilyRole };

/** Who is acting: signed-in web user, a paired device, or the desktop app with the shared token. */
export async function notifyActor(req: Request): Promise<NotifyActor | null> {
  const r = await resolve(req);
  if (!r) return null;
  if (r.deviceId === "desktop") return { ...r, role: "owner" };
  // no family membership (unbound device, plain viewer account) = only household-wide cards
  const member = await homeActorFromRequest(req).catch(() => null);
  return { ...r, role: member?.role ?? "guest" };
}

async function resolve(req: Request): Promise<Omit<NotifyActor, "role"> | null> {
  const d = await deviceFromRequest(req);
  if (d) return { by: `device:${d.name}`, deviceId: d.id, userId: d.userId, locale: isLocale(d.language) ? d.language : headerLocale(req) };
  const u = await getCurrentUser().catch(() => null);
  if (u) return { by: u.email, deviceId: null, userId: u.id, locale: headerLocale(req) };
  if (espAuthorized(req)) return { by: "desktop", deviceId: "desktop", userId: null, locale: headerLocale(req) };
  return null;
}

/** Same resolution as `src/i18n/request.ts`: the `vmui_locale` cookie, then Accept-Language, then English. */
function headerLocale(req: Request): Locale {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  const fromCookie = m?.[1] ? decodeURIComponent(m[1]) : undefined;
  if (isLocale(fromCookie)) return fromCookie;
  return localeFromAcceptLanguage(req.headers.get("accept-language")) ?? DEFAULT_LOCALE;
}
