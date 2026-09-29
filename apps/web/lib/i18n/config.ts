/** Locale plumbing shared by server and client code (no React imports here). */

export const LOCALES = ["en", "ru", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "opsmind.locale";
export const LOCALE_STORAGE_KEY = "opsmind.locale";

/** Endonyms: a language is always offered in its own name, whatever the active UI language. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", ru: "Русский", ar: "العربية" };

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

export const dirOf = (l: Locale): "ltr" | "rtl" => (l === "ar" ? "rtl" : "ltr");

// Arabic keeps Latin digits: KPI values sit next to Latin units ("$", "h", "%") and read better that way.
const INTL_LOCALE: Record<Locale, string> = { en: "en-US", ru: "ru-RU", ar: "ar-u-nu-latn" };
export const intlLocale = (l: Locale) => INTL_LOCALE[l];

/** First supported language in an Accept-Language header or a navigator.languages list. */
export function matchLocale(list: string | readonly string[] | null | undefined): Locale | null {
  const tags = typeof list === "string" ? list.split(",").map((s) => s.split(";")[0]) : (list ?? []);
  for (const tag of tags) {
    const base = tag.trim().toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}
