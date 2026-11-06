import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeFromAcceptLanguage } from "./config";
import { loadMessages } from "./messages";
import { householdTimeZone } from "@/lib/household";

// No locale in the URL: the cookie set by the switcher wins, then the browser's
// Accept-Language, then English. Same resolution the notify pipeline uses for
// cards it sends to a device (lib/notify/i18n.ts), so a phone and the web agree.
export default getRequestConfig(async () => {
  const jar = await cookies();
  const fromCookie = jar.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(fromCookie) ? fromCookie : (localeFromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE);
  return { locale, messages: await loadMessages(locale), timeZone: householdTimeZone() };
});
