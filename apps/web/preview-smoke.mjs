#!/usr/bin/env node
/**
 * Smoke test for the static interactive preview (STATIC_PREVIEW=1 build in out/): serves it the way a
 * static host does, under its base path, and drives it in Chromium. It proves the preview is honest
 * and self-contained: the banner is there, the demo works, and not one request leaves for an API.
 *
 *   PREVIEW_BASE_PATH=/opsmind node apps/web/preview-smoke.mjs
 *
 * Env: PREVIEW_BASE_PATH (as built), PREVIEW_OUT (default apps/web/out), PORT (default 4173),
 * BROWSER_CHANNEL (e.g. msedge/chrome to use an installed browser), SERVE_ONLY=1 to just serve it.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(process.env.PREVIEW_OUT ?? fileURLToPath(new URL("./out", import.meta.url)));
const BASE = (process.env.PREVIEW_BASE_PATH ?? "").trim().replace(/^\/*/, "/").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SITE = `${ORIGIN}${BASE}/`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

if (!existsSync(join(OUT, "index.html"))) {
  console.error(`preview-smoke: ${OUT}/index.html not found; build with STATIC_PREVIEW=1 NEXT_PUBLIC_PREVIEW=1 first`);
  process.exit(1);
}

/** Static-host rules: only paths under the base path, a directory serves its index.html, else 404.html. */
function resolveFile(pathname) {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
  const file = resolve(join(OUT, decodeURIComponent(pathname.slice(BASE.length))));
  if (file !== OUT && !file.startsWith(OUT + sep)) return null;
  if (existsSync(file) && statSync(file).isDirectory()) return existsSync(join(file, "index.html")) ? join(file, "index.html") : null;
  return existsSync(file) ? file : null;
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, ORIGIN);
  const file = resolveFile(pathname);
  const notFound = join(OUT, "404.html");
  if (!file) {
    res.writeHead(404, { "content-type": TYPES[".html"] });
    return existsSync(notFound) ? createReadStream(notFound).pipe(res) : res.end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

if (process.env.SERVE_ONLY === "1") {
  console.log(`serving ${OUT} at ${SITE} (Ctrl+C to stop)`);
} else {
  let failed = false;
  try {
    await smoke();
  } catch (err) {
    failed = true;
    console.error(`FAIL ${err.message}`);
  } finally {
    server.close();
  }
  process.exit(failed ? 1 : 0);
}

async function smoke() {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  const offending = [];
  const pageErrors = [];
  const watch = (context) =>
    context.on("request", (r) => {
      const url = new URL(r.url());
      // data:/blob: are in-page; edge:// and chrome:// are the browser's own UI (e.g. its download bubble).
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      // The whole point: a static site with recorded data. No API call, and nothing from anywhere else.
      if (url.pathname.includes("/api/") || url.origin !== ORIGIN) offending.push(r.url());
    });
  const check = (ok, what) => {
    if (!ok) throw new Error(what);
    console.log(`ok   ${what}`);
  };

  try {
    const context = await browser.newContext({ locale: "en-US", acceptDownloads: true });
    watch(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const byId = (id) => page.getByTestId(id);

    await page.goto(SITE);
    await byId("preview-banner").waitFor();
    check((await byId("preview-banner").innerText()).includes("Interactive preview with recorded data"), "banner says what this is");
    check((await byId("preview-codespaces").getAttribute("href")).startsWith("https://codespaces.new/"), "banner links to Codespaces");
    check((await byId("demo-login").innerText()).trim() !== "", "the demo button is there");
    check(!/\blive\b|real[- ]time/i.test(await page.locator("body").innerText()), "the landing page never claims to be live");

    await byId("demo-login").click();
    await page.waitForURL(/\/dashboard\/analytics\/?$/);
    await byId("kpi-card").nth(5).waitFor();
    check((await byId("kpi-card").count()) === 6, "analytics renders 6 KPI cards");
    // Exported with trailing slashes, the browser path is ".../analytics/"; the menu must still match it.
    check((await byId("nav-analytics").getAttribute("aria-current")) === "page", "the menu marks the current page");
    await byId("insights-summary").waitFor();
    check((await byId("insights-summary").innerText()).trim().length > 20, "AI insights summary is shown");
    const today = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date());
    check((await byId("analytics-period").innerText()).includes(today), `period ends today (${today})`);
    check((await byId("preview-banner").innerText()).includes("Recorded on"), "banner shows the recording date");

    await byId("analytics-range-90").click();
    await byId("analytics-bucket").selectOption("week");
    await page.waitForFunction(() => document.querySelector('[data-testid="analytics-period"]')?.textContent?.includes("90"));
    check((await byId("kpi-card").count()) === 6, "90 days, weekly: still 6 KPI cards");

    await byId("analytics-range-30").click();
    await byId("analytics-bucket").selectOption("day");
    const [xlsx] = await Promise.all([page.waitForEvent("download"), byId("analytics-export-xlsx").click()]);
    const bytes = readFileSync(await xlsx.path());
    check(xlsx.suggestedFilename().endsWith(".xlsx") && bytes.subarray(0, 2).toString() === "PK", `default view exports the recorded ${xlsx.suggestedFilename()}`);
    await byId("analytics-range-7").click();
    await byId("analytics-export-pdf").click();
    await byId("analytics-notice").waitFor();
    check((await byId("analytics-notice").innerText()).includes("default view"), "other views explain the export limit");

    await byId("nav-documents").click();
    await byId("doc-row").first().waitFor();
    check((await byId("doc-row").count()) > 0, `documents listed (${await byId("doc-row").count()})`);
    check((await byId("doc-upload-form").count()) === 0, "viewer sees no upload form");
    check(
      (await byId("nav-documents").getAttribute("aria-current")) === "page" && !(await byId("nav-analytics").getAttribute("aria-current")),
      "the menu follows client navigation",
    );

    // The answer is revealed word by word; judge it only once it is complete.
    const typed = () => page.locator('[data-testid="ask-answer"][data-typing="done"]').waitFor();
    // A recording of "couldn't find anything" would pass for an answer, so each check wants a cited source.
    const answered = async () => {
      const text = await byId("ask-answer").innerText();
      return text.trim() !== "" && !/couldn't find/i.test(text) && (await byId("ask-source").count()) > 0;
    };
    await byId("nav-ask").click();
    await byId("ask-example-1").click();
    await typed();
    check(await answered(), "example question gets the recorded answer, with sources");
    check((await page.locator("main").innerText()).includes("recorded answer"), "the answer is labelled as recorded");
    await byId("ask-input").fill("What will the weather be on Mars tomorrow?");
    await byId("ask-submit").click();
    // Scoped to the finished answer: the screen-reader live region (and, while typing, a hidden full copy)
    // holds the same text, so a page-wide getByText would match several elements and fail strict mode.
    await page
      .locator('[data-testid="ask-answer"][data-typing="done"]', { hasText: "answers only the example questions" })
      .waitFor();
    check(true, "a free-form question gets the labelled preview message");

    // Most visitors read Russian: its examples must answer too, not replay a failure.
    await byId("lang-ru").click();
    await page.waitForFunction(() => document.documentElement.lang === "ru");
    await byId("ask-example-1").click();
    await page.getByText("записанный ответ").waitFor();
    await typed();
    check(await answered(), "a Russian example question gets an answer with sources, labelled in Russian");

    await byId("lang-ar").click();
    await page.waitForFunction(() => document.documentElement.dir === "rtl");
    check((await page.evaluate(() => document.documentElement.lang)) === "ar", "Arabic sets lang=ar dir=rtl");
    check(/[؀-ۿ]/.test(await byId("preview-banner").innerText()), "banner is translated");
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dir === "rtl");
    check(true, "Arabic survives a reload");
    check((await byId("nav-ask").getAttribute("aria-current")) === "page", "after a reload the menu marks the current page");
    await context.close();

    // The static HTML is English/LTR for everyone; the inline head script must switch before any app JS runs.
    const shell = await browser.newContext();
    watch(shell);
    await shell.addInitScript(() => localStorage.setItem("opsmind.locale", "ar"));
    await shell.route("**/_next/static/chunks/**", (route) => route.abort());
    const raw = await shell.newPage();
    await raw.goto(`${SITE}login/`);
    const html = await raw.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
    check(html.lang === "ar" && html.dir === "rtl", "saved Arabic is RTL before the app loads (no LTR flash)");
    await shell.close();

    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(" | ")}` : ""}`);
    check(offending.length === 0, `no request to any /api/ URL or other host${offending.length ? `: ${offending.join(", ")}` : ""}`);
  } finally {
    await browser.close();
  }
}
