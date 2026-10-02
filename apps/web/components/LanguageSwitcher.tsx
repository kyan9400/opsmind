"use client";

import { LOCALE_NAMES, LOCALES } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";

/** EN / RU / AR segmented control. Codes stay Latin in every language so users can always find their own. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t("lang.label")} data-testid="lang-switcher" className={`segmented ${className}`}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          title={LOCALE_NAMES[l]}
          aria-label={`${l.toUpperCase()} — ${LOCALE_NAMES[l]}`}
          aria-pressed={locale === l}
          data-testid={`lang-${l}`}
          onClick={() => setLocale(l)}
          className="segment px-2 py-0.5 text-xs"
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
