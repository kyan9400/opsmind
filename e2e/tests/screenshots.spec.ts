import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { topAnomalyMarker, waitForAnalytics } from "../support/analytics";
import { loadDemoKpis, registerOwner, uploadDocuments, useToken, type Account } from "../support/api";
import { REFUND_QUESTION, SAMPLE_DOCS } from "../support/docs";

/**
 * README images. Opt-in (SCREENSHOTS=1, see playwright.config.ts) because they overwrite docs/screenshots.
 * One demo tenant is shared by every shot, so the describe block is serial and seeded once.
 */
const OUT = path.join(__dirname, "..", "..", "docs", "screenshots");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, name), animations: "disabled", caret: "hide", fullPage: false });

test.describe("README screenshots", { tag: "@screenshots" }, () => {
  test.skip(process.env.SCREENSHOTS !== "1", "set SCREENSHOTS=1 to regenerate docs/screenshots");
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  let owner: Account;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    owner = await registerOwner("screens", "Northwind Supply");
    await loadDemoKpis(owner);
    await uploadDocuments(owner, SAMPLE_DOCS);
  });

  async function openAnalytics(page: Page) {
    await page.goto("/dashboard/analytics");
    await waitForAnalytics(page);
  }

  /** Hovers the anomaly marker nearest the top of the page, so the tooltip is inside the 900px frame. */
  async function hoverTopAnomaly(page: Page) {
    const top = await topAnomalyMarker(page);
    // Only scrolls when no marker is above the fold; otherwise the shot keeps the page header in frame.
    await top.scrollIntoViewIfNeeded();
    const box = await top.boundingBox();
    if (!box) throw new Error("anomaly marker has no layout box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // The chart's transparent hit layer sits above the markers, so drive the mouse directly instead of
    // locator.hover(), which would refuse because another element intercepts the pointer.
    await page.mouse.move(x - 20, y);
    await page.mouse.move(x, y, { steps: 4 });
    await expect(page.getByTestId("chart-tooltip")).toBeVisible();
  }

  test("landing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing-register")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shot(page, "landing.png");
  });

  test("analytics", async ({ page }) => {
    await useToken(page, owner.token);
    await openAnalytics(page);
    await expect(page.getByTestId("analytics-range-30")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("analytics-bucket")).toHaveValue("day");
    await hoverTopAnomaly(page);
    await shot(page, "analytics.png");
  });

  test("ask", async ({ page }) => {
    await useToken(page, owner.token);
    await page.goto("/dashboard/ask");
    await page.getByTestId("ask-input").fill(REFUND_QUESTION);
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("ask-answer")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ask-source").first()).toBeVisible();
    await page.getByTestId("ask-input").blur();
    await shot(page, "ask.png");
  });

  test("documents", async ({ page }) => {
    await useToken(page, owner.token);
    await page.goto("/dashboard/documents");
    await expect(page.getByTestId("doc-row")).toHaveCount(SAMPLE_DOCS.length);
    await expect(page.locator('[data-testid="doc-status"]:not([data-status="ready"])')).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await shot(page, "documents.png");
  });

  test.describe("dark", () => {
    test.use({ colorScheme: "dark" });

    test("analytics dark", async ({ page }) => {
      await useToken(page, owner.token);
      await openAnalytics(page);
      await hoverTopAnomaly(page);
      await shot(page, "analytics-dark.png");
    });
  });

  test.describe("arabic", () => {
    test("analytics RTL", async ({ page, context, baseURL }) => {
      // The locale cookie makes the server render Arabic/RTL on first paint, exactly as a returning visitor sees it.
      await context.addCookies([{ name: "opsmind.locale", value: "ar", url: baseURL! }]);
      await useToken(page, owner.token);
      await openAnalytics(page);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await shot(page, "analytics-ar.png");
    });
  });
});
