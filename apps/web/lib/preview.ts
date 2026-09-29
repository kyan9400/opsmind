/**
 * The static "interactive preview" build (NEXT_PUBLIC_PREVIEW=1, see next.config.mjs): the UI runs on
 * recorded API responses in the browser, with no server behind it. Every value is inlined at build time.
 * Code that must stay out of normal builds (the mock and its fixtures) tests
 * `process.env.NEXT_PUBLIC_PREVIEW === "1"` inline instead, so webpack can drop that branch.
 */
export const PREVIEW = process.env.NEXT_PUBLIC_PREVIEW === "1";

/** "YYYY-MM-DD" (UTC) the fixtures were recorded on; empty outside the preview. */
export const PREVIEW_RECORDED_DAY = process.env.NEXT_PUBLIC_PREVIEW_RECORDED_DAY ?? "";

const repo = process.env.NEXT_PUBLIC_PREVIEW_REPO || "kyan9400/opsmind";
export const REPO_URL = `https://github.com/${repo}`;
export const CODESPACES_URL = `https://codespaces.new/${repo}?quickstart=1`;
