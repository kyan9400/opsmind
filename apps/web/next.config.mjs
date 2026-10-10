import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in same-origin API. When API_INTERNAL_URL is set (e.g. http://api:4000), the Next.js server
// proxies /api/* to it, so the browser can use relative URLs (build with NEXT_PUBLIC_API_URL="").
// Codespaces serves every forwarded port on its own origin behind GitHub sign-in, which makes a
// browser-side cross-origin call to the API brittle. Rewrites are frozen into the standalone build
// (routes-manifest.json), so this is a build-time setting, not a runtime one.
const apiInternalUrl = process.env.API_INTERNAL_URL?.replace(/\/+$/, "");

// Interactive preview (off by default). NEXT_PUBLIC_PREVIEW=1: lib/api.ts answers from responses recorded
// on the real stack (scripts/record-preview.mjs -> preview-data/) instead of calling an API.
// STATIC_PREVIEW=1 also exports plain files for a static host (out/), under PREVIEW_BASE_PATH: SourceCraft
// Sites serves a repository at https://<org>.sourcecraft.site/<repo>/, so there it is "/<repo>".
const preview = process.env.NEXT_PUBLIC_PREVIEW === "1";
const staticPreview = process.env.STATIC_PREVIEW === "1";
if (staticPreview && !preview) {
  throw new Error("STATIC_PREVIEW=1 needs NEXT_PUBLIC_PREVIEW=1: a static export has no server to call.");
}

const previewDir = join(dirname(fileURLToPath(import.meta.url)), "preview-data");
const FIXTURES = ["meta.json", "responses.json", "ask.json", "export.xlsx", "export.pdf"];

function previewMeta() {
  const missing = FIXTURES.filter((f) => !existsSync(join(previewDir, f)));
  if (missing.length) {
    throw new Error(
      `The preview build needs recorded fixtures; missing: ${missing.map((f) => `apps/web/preview-data/${f}`).join(", ")}.\n` +
        "They are generated, not committed: start the stack, seed the demo workspace, then run\n" +
        "  DEMO_PASSWORD=... node scripts/record-preview.mjs\n" +
        "(the Preview workflow does this in CI; see deploy/sourcecraft/README.md).",
    );
  }
  return JSON.parse(readFileSync(join(previewDir, "meta.json"), "utf8"));
}

function basePath() {
  const raw = (process.env.PREVIEW_BASE_PATH ?? "").trim().replace(/^\/*/, "/").replace(/\/+$/, "");
  if (!/^(\/[\w.-]+)*$/.test(raw)) throw new Error(`PREVIEW_BASE_PATH must look like /opsmind, got "${raw}"`);
  return raw;
}

function previewConfig() {
  const meta = previewMeta();
  return {
    env: {
      NEXT_PUBLIC_PREVIEW: "1",
      NEXT_PUBLIC_PREVIEW_RECORDED_DAY: meta.recordedDay,
      NEXT_PUBLIC_PREVIEW_REPO: process.env.PREVIEW_REPO || process.env.GITHUB_REPOSITORY || "kyan9400/opsmind",
      // The demo button needs both. Only the in-browser mock checks them, so no real password is needed.
      NEXT_PUBLIC_DEMO_EMAIL: process.env.NEXT_PUBLIC_DEMO_EMAIL || meta.demoEmail,
      NEXT_PUBLIC_DEMO_PASSWORD: process.env.NEXT_PUBLIC_DEMO_PASSWORD || "preview",
    },
    webpack(config, { isServer }) {
      config.resolve.alias["@preview-data"] = previewDir;
      // The recorded xlsx/pdf become plain files under _next/static/media (copied into out/); importing one
      // gives its URL.
      config.module.rules.push({
        test: /\.(xlsx|pdf)$/,
        include: previewDir,
        type: "asset/resource",
        generator: { filename: "static/media/[name].[contenthash:8][ext]", emit: !isServer },
      });
      return config;
    },
  };
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Always defined, so `process.env.NEXT_PUBLIC_PREVIEW === "1"` is a build-time constant and webpack
  // leaves the mock and its fixtures out of normal builds entirely.
  env: { NEXT_PUBLIC_PREVIEW: "" },
  // Next streams metadata into <body> for everyone but a list of known bots; Lighthouse and some link
  // previewers then miss the description. Ours only reads the language cookie, so waiting costs nothing.
  htmlLimitedBots: /.*/,
  ...(preview && previewConfig()),
  ...(staticPreview
    ? // No rewrites: a static export has no server to proxy with.
      { output: "export", basePath: basePath(), trailingSlash: true, images: { unoptimized: true } }
    : {
        output: "standalone",
        ...(apiInternalUrl && {
          // The proxy gives up after 30 s by default; a real LLM (OpenAI/Anthropic/Ollama) can take longer to answer.
          experimental: { proxyTimeout: 120_000 },
          async rewrites() {
            return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
          },
        }),
      }),
};
if (preview) {
  // A custom webpack() would otherwise switch Next to an in-process compile; keep the same build worker
  // as the default build (the in-process path exited silently mid-build on Windows).
  nextConfig.experimental = { ...nextConfig.experimental, webpackBuildWorker: true };
}

export default nextConfig;
