import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { topAnomalyMarker, waitForAnalytics } from "../support/analytics";
import { fakeCursor, Tour, waitForDemoDocuments } from "../support/demo";
import { REFUND_QUESTION } from "../support/docs";

/**
 * README demo: a ~25 s guided tour, recorded to e2e/demo-video/tour.webm for scripts/make-demo-gif.sh.
 * Opt-in (DEMO_VIDEO=1, see playwright.config.ts). It signs in as the viewer that apps/api/src/seedDemo.ts
 * creates, so it films exactly what a visitor to the public demo sees.
 */
const OUT = path.join(__dirname, "..", "demo-video");
const SIZE = { width: 1280, height: 800 };

test("README demo tour", { tag: "@demo" }, async ({ browser, baseURL }, testInfo) => {
  test.skip(process.env.DEMO_VIDEO !== "1", "set DEMO_VIDEO=1 to record the README demo");
  test.setTimeout(180_000);
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  // Fail instead of skipping: a missing video would otherwise only show up later as a stale GIF.
  if (!email || !password) throw new Error("set DEMO_EMAIL and DEMO_PASSWORD to the login seedDemo.js created");

  await waitForDemoDocuments(email, password);

  // A context of its own rather than the page fixture, so the video is recorded 1:1 at the viewport size.
  const context = await browser.newContext({
    baseURL,
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    recordVideo: { dir: testInfo.outputPath("video"), size: SIZE },
  });
  await context.addInitScript(fakeCursor);
  const recordingStarted = Date.now();
  const page = await context.newPage();
  const video = page.video()!;
  const tour = new Tour(page);
  const html = page.locator("html");
  let lead = 0;

  try {
    await page.goto("/");
    await expect(page.getByTestId("landing-signin")).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Frames before the landing page painted are blank; the GIF script trims them using this offset.
    lead = (Date.now() - recordingStarted) / 1000;
    await tour.enter();
    await tour.pause(1500);

    // Sign in the way a visitor would, typing the demo credentials.
    await tour.click(page.getByTestId("landing-signin"));
    await expect(page.getByTestId("login-form")).toBeVisible();
    await tour.type(page.getByTestId("login-email"), email, 45);
    await tour.type(page.getByTestId("login-password"), password, 45);
    await tour.click(page.getByTestId("login-submit"));
    await expect(page.getByTestId("overview-welcome")).toBeVisible();

    // Analytics opens on 30 days, daily, with the detector's markers; hovering one explains the anomaly.
    await tour.click(page.getByTestId("nav-analytics"));
    await waitForAnalytics(page);
    await expect(page.getByTestId("analytics-range-30")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("analytics-bucket")).toHaveValue("day");
    await tour.pause(600);
    const marker = await topAnomalyMarker(page);
    // The tooltip is pinned to the top of the chart, so the whole card must be in frame, not just the dot.
    await tour.reveal(marker.locator("xpath=ancestor::section[@data-testid='kpi-card']"));
    await tour.glideTo(marker, 900);
    await expect(page.getByTestId("chart-tooltip")).toBeVisible();
    await tour.pause(2200);

    // Ask AI: the refund policy holds the answer, so it comes back with numbered citations.
    await tour.click(page.getByTestId("nav-ask"));
    await tour.type(page.getByTestId("ask-input"), REFUND_QUESTION, 35);
    await tour.click(page.getByTestId("ask-submit"));
    const answer = page.getByTestId("ask-answer");
    // The video keeps the word-by-word reveal; wait until it has finished before moving on.
    await expect(answer).toHaveAttribute("data-typing", "done", { timeout: 30_000 });
    await expect(answer).toContainText("30");
    await expect(page.getByTestId("ask-source").first()).toBeVisible();
    // Keep the answer card at the top and bring as many source cards as fit into view below it.
    await tour.reveal(page.getByTestId("ask-sources"), answer.locator(".."));
    // Point at a citation marker: it is what ties the sentence to its source card.
    const cite = answer.locator('a[href^="#source-"]').first();
    await tour.glideTo((await cite.count()) ? cite : page.getByTestId("ask-source").first());
    await tour.pause(2200);

    // Arabic from the switcher on analytics: the layout mirrors to RTL while charts keep time left to right.
    await tour.click(page.getByTestId("nav-analytics"));
    await waitForAnalytics(page);
    await tour.click(page.getByTestId("lang-ar"));
    await expect(html).toHaveAttribute("dir", "rtl");
    await tour.pause(2200);
    await tour.click(page.getByTestId("lang-en"));
    await expect(html).toHaveAttribute("dir", "ltr");
    await tour.pause(1200);
  } finally {
    // Closing the context is what finalizes the video, so a failed run still leaves its clip in test-results.
    await context.close();
  }

  fs.mkdirSync(OUT, { recursive: true });
  await video.saveAs(path.join(OUT, "tour.webm"));
  fs.writeFileSync(path.join(OUT, "tour.start"), `${lead.toFixed(2)}\n`);
});
