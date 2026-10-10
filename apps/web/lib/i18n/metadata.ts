import type { Metadata } from "next";
import { getRequestLocale } from "./server";
import { createTranslator } from "./translate";
import type { TextKey } from "./types";

/**
 * `generateMetadata` for a page whose component is a client component (and so cannot export metadata
 * itself): a tiny server layout next to it sets the tab title, which the root template turns into
 * "Analytics · OpsMind".
 */
export function pageTitle(key: TextKey) {
  return async function generateMetadata(): Promise<Metadata> {
    const { locale } = await getRequestLocale();
    return { title: createTranslator(locale)(key) };
  };
}
