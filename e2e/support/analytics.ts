import { expect, type Locator, type Page } from "@playwright/test";

/** Analytics fully settled: six charts drawn, insights in, no requests in flight. */
export async function waitForAnalytics(page: Page): Promise<void> {
  await expect(page.getByTestId("kpi-card")).toHaveCount(6);
  await expect(page.getByTestId("line-chart").locator("svg")).toHaveCount(6);
  await expect(page.getByTestId("anomaly-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("insights-panel")).toHaveAttribute("aria-busy", "false");
  await page.waitForLoadState("networkidle");
}

/**
 * The anomaly marker nearest the top of the page, so its tooltip fits in frame with the least scrolling.
 * The chart's transparent hit layer sits above the markers, so callers must drive page.mouse to the
 * marker's box: locator.hover() refuses because another element intercepts the pointer.
 */
export async function topAnomalyMarker(page: Page): Promise<Locator> {
  const markers = page.getByTestId("line-chart").locator('circle[r="5"]');
  await expect(markers.first()).toBeAttached();
  let top = markers.first();
  let topY = Infinity;
  for (const m of await markers.all()) {
    const box = await m.boundingBox();
    if (box && box.y < topY) [top, topY] = [m, box.y];
  }
  return top;
}
