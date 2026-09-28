import type { Metadata } from "next";
import { dirOf } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/provider";
import { getRequestLocale } from "@/lib/i18n/server";
import { createTranslator } from "@/lib/i18n/translate";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRequestLocale();
  return { title: "OpsMind", description: createTranslator(locale)("meta.description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, fromCookie } = await getRequestLocale();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>
        <I18nProvider initialLocale={locale} fromCookie={fromCookie}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
