"use client";

import { LOCALE_NAMES, LOCALES } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";

/** EN / RU / AR segmented control. Codes stay Latin in every language so users can always find their own. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("lang.label")}
      data-testid="lang-switcher"
      className={`inline-flex rounded-lg border border-zinc-300 p-0.5 text-xs dark:border-zinc-700 ${className}`}
    >
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
          className={`rounded-md px-2 py-1 font-medium ${
            locale === l
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
