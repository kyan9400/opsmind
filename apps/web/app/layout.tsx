import type { Metadata, Viewport } from "next";
import { PreviewBanner } from "@/components/PreviewBanner";
import { dirOf, type Locale } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/provider";
import { getRequestLocale, LOCALE_BOOTSTRAP, STATIC_SHELL } from "@/lib/i18n/server";
import { createTranslator } from "@/lib/i18n/translate";
import { PREVIEW } from "@/lib/preview";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// Open Graph wants language_TERRITORY.
const OG_LOCALE: Record<Locale, string> = { en: "en_US", ru: "ru_RU", ar: "ar_AR" };

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRequestLocale();
  const t = createTranslator(locale);
  const title = PREVIEW ? t("preview.metaTitle") : t("meta.title");
  const description = t("meta.description");
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: title, template: "%s · OpsMind" },
    description,
    applicationName: "OpsMind",
    // Link previews (LinkedIn, Telegram, Slack); the image is app/opengraph-image.png.
    openGraph: { type: "website", siteName: "OpsMind", title, description, locale: OG_LOCALE[locale] },
    twitter: { card: "summary_large_image", title, description },
    // The preview duplicates the demo with recorded data; only the live demo should show up in search.
    ...(PREVIEW && { robots: { index: false, follow: false } }),
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1020" },
  ],
};

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
        <I18nProvider initialLocale={locale} fromCookie={fromCookie} serverRendered={!STATIC_SHELL}>
          {PREVIEW && <PreviewBanner />}
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
