"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { dirOf, isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, matchLocale, type Locale } from "./config";
import { createTranslator } from "./translate";
import type { Translator } from "./types";

interface I18nContextValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (l: Locale) => void;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readStored(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null; // storage can be blocked (private mode, disabled cookies)
  }
}

function persist(l: Locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    /* the cookie below is enough for the server-rendered first paint */
  }
  document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
}

export function I18nProvider({
  initialLocale,
  fromCookie,
  children,
}: {
  initialLocale: Locale;
  fromCookie: boolean;
  children: React.ReactNode;
}) {
  // Start from the server's choice so the hydrated tree matches the HTML exactly.
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    // Without a cookie the server only had Accept-Language to go on; refine with what the browser knows.
    if (fromCookie) return;
    const stored = readStored();
    if (stored) persist(stored); // restore the cookie so the next first paint is right
    const next = stored ?? matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
    if (next && next !== initialLocale) setLocaleState(next);
  }, [fromCookie, initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirOf(locale);
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    persist(l);
  }, []);

  const value = useMemo(
    () => ({ locale, dir: dirOf(locale), setLocale, t: createTranslator(locale) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export const useT = () => useI18n().t;
