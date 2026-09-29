import { ar } from "./ar";
import { intlLocale, type Locale } from "./config";
import { en } from "./en";
import { ru } from "./ru";
import type { Dict, MessageKey, PluralForms, Translator, Vars } from "./types";

const DICTS: Record<Locale, Dict> = { en, ru, ar };

/**
 * Pure translator factory (usable on the server, e.g. for metadata). `{name}` placeholders are
 * interpolated, numbers are formatted for the locale, and plural entries pick their form from `count`
 * via Intl.PluralRules (Russian one/few/many, Arabic zero/one/two/few/many). Unknown placeholders are
 * left intact so callers can splice in rich content (see `{demo}` on the analytics page).
 */
export function createTranslator(locale: Locale): Translator {
  const dict = DICTS[locale];
  const plurals = new Intl.PluralRules(intlLocale(locale));
  const numbers = new Intl.NumberFormat(intlLocale(locale));

  return ((key: MessageKey, vars?: Vars) => {
    const entry = dict[key] as string | PluralForms;
    const template = typeof entry === "string" ? entry : (entry[plurals.select(Number(vars?.count ?? 0))] ?? entry.other);
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const v = vars[name];
      return v === undefined ? match : typeof v === "number" ? numbers.format(v) : v;
    });
  }) as Translator;
}
