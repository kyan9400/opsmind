import type { MetadataRoute } from "next";
import { PREVIEW } from "@/lib/preview";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

// The landing and sign-in pages are public; the dashboard only shows a signed-in workspace. No trailing
// slash: "/dashboard/" would leave the overview page itself (/dashboard) crawlable. The interactive
// preview is a copy of the demo, kept out of search results by a noindex tag (app/layout.tsx).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/dashboard" },
    ...(!PREVIEW && { sitemap: `${SITE_URL}/sitemap.xml` }),
  };
}
