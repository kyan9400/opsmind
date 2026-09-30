import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, dirOf, isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, LOCALES, matchLocale, type Locale } from "./config";

/**
 * Static export (STATIC_PREVIEW=1, next.config.mjs): one HTML file per page serves every visitor, so
 * there is no request to read, and cookies()/headers() would fail the export.
 */
export const STATIC_SHELL = process.env.STATIC_PREVIEW === "1";

/**
 * Locale for the first paint: an explicit choice (cookie) wins, then the browser's Accept-Language.
 * Resolving it on the server lets <html lang/dir> be right before hydration, so Arabic never flashes LTR.
 * The static shell renders the default locale, and LOCALE_BOOTSTRAP fixes lang/dir in the browser.
 */
export async function getRequestLocale(): Promise<{ locale: Locale; fromCookie: boolean }> {
  if (STATIC_SHELL) return { locale: DEFAULT_LOCALE, fromCookie: false };
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return { locale: saved, fromCookie: true };
  return { locale: matchLocale((await headers()).get("accept-language")) ?? DEFAULT_LOCALE, fromCookie: false };
}

/**
 * Inline <head> script for the static shell: the same choice as the client I18nProvider (saved
 * language, else the browser's), applied to <html lang/dir> before the first paint.
 */
export const LOCALE_BOOTSTRAP = `(function(){var L=${JSON.stringify(LOCALES)},R=${JSON.stringify(
  LOCALES.filter((l) => dirOf(l) === "rtl"),
)},l=null;try{l=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch(e){}if(L.indexOf(l)<0){l=null;var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];for(var i=0;i<n.length&&!l;i++){var b=String(n[i]).trim().toLowerCase().split("-")[0];if(L.indexOf(b)>=0)l=b}}if(l){var d=document.documentElement;d.lang=l;d.dir=R.indexOf(l)<0?"ltr":"rtl"}})();`;
