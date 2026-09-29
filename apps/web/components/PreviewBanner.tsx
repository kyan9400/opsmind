"use client";

import { intlLocale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";
import { CODESPACES_URL, PREVIEW_RECORDED_DAY, REPO_URL } from "@/lib/preview";

/**
 * Shown on every page of the static preview build. The preview must never pass for the live system:
 * it says what it is (recorded data, no server) and where the real one runs.
 */
export function PreviewBanner() {
  const { t, locale } = useI18n();
  const recorded = PREVIEW_RECORDED_DAY
    ? new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(`${PREVIEW_RECORDED_DAY}T00:00:00Z`),
      )
    : null;
  const link = "font-medium underline underline-offset-2 hover:no-underline";

  return (
    <div
      role="note"
      aria-label={t("preview.label")}
      data-testid="preview-banner"
      className="border-b border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6">
        <span>
          <strong className="font-semibold">{t("preview.banner")}</strong> {t("preview.bannerFull")}
        </span>
        <a href={CODESPACES_URL} target="_blank" rel="noopener noreferrer" className={link} data-testid="preview-codespaces">
          {t("preview.openCodespaces")}
        </a>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={link}>
          {t("preview.source")}
        </a>
        {recorded && (
          <span className="text-xs opacity-80" data-testid="preview-recorded">
            {t("preview.recordedOn", { date: recorded })}
          </span>
        )}
      </p>
    </div>
  );
}
