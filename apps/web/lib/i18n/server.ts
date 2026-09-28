import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, matchLocale, type Locale } from "./config";

/**
 * Locale for the first paint: an explicit choice (cookie) wins, then the browser's Accept-Language.
 * Resolving it on the server lets <html lang/dir> be right before hydration, so Arabic never flashes LTR.
 */
export async function getRequestLocale(): Promise<{ locale: Locale; fromCookie: boolean }> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return { locale: saved, fromCookie: true };
  return { locale: matchLocale((await headers()).get("accept-language")) ?? DEFAULT_LOCALE, fromCookie: false };
}
