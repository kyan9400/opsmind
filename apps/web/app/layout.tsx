import type { Metadata } from "next";
import { PreviewBanner } from "@/components/PreviewBanner";
import { dirOf } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/provider";
import { getRequestLocale, LOCALE_BOOTSTRAP, STATIC_SHELL } from "@/lib/i18n/server";
import { createTranslator } from "@/lib/i18n/translate";
import { PREVIEW } from "@/lib/preview";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRequestLocale();
  const t = createTranslator(locale);
  return { title: PREVIEW ? t("preview.metaTitle") : "OpsMind", description: t("meta.description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, fromCookie } = await getRequestLocale();
  return (
    // In the static shell the head script may change lang/dir before hydration, on purpose.
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning={STATIC_SHELL || undefined}>
      {STATIC_SHELL && (
        <head>
          <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOTSTRAP }} />
        </head>
      )}
      <body>
        <I18nProvider initialLocale={locale} fromCookie={fromCookie}>
          {PREVIEW && <PreviewBanner />}
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
