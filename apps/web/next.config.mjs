// Opt-in same-origin API. When API_INTERNAL_URL is set (e.g. http://api:4000), the Next.js server
// proxies /api/* to it, so the browser can use relative URLs (build with NEXT_PUBLIC_API_URL="").
// Codespaces serves every forwarded port on its own origin behind GitHub sign-in, which makes a
// browser-side cross-origin call to the API brittle. Rewrites are frozen into the standalone build
// (routes-manifest.json), so this is a build-time setting, not a runtime one.
const apiInternalUrl = process.env.API_INTERNAL_URL?.replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  ...(apiInternalUrl && {
    // The proxy gives up after 30 s by default; a real LLM (OpenAI/Anthropic/Ollama) can take longer to answer.
    experimental: { proxyTimeout: 120_000 },
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
    },
  }),
};

export default nextConfig;
