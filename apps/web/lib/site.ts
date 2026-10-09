/**
 * Public origin for absolute URLs in metadata (the link-preview image, robots.txt, sitemap.xml); Next
 * adds any base path itself. NEXT_PUBLIC_SITE_URL wins (Docker/Compose/Helm builds and the Preview
 * workflow set it); on Vercel the project's production domain is known without it.
 */
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")
).replace(/\/+$/, "");
