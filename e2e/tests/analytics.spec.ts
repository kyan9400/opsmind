import { expect, test, type Page } from "@playwright/test";
import { registerOwner, useToken } from "../support/api";

const dashboardResponse = (page: Page, days: number, bucket: string) =>
  page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname.endsWith("/metrics/dashboard") &&
      url.searchParams.get("days") === String(days) &&
      url.searchParams.get("bucket") === bucket &&
      r.ok()
    );
  });

test("demo data, filters, table view and Excel export", async ({ page }) => {
  const owner = await registerOwner("analytics");
  await useToken(page, owner.token);

  await page.goto("/dashboard/analytics");
  await expect(page.getByTestId("analytics-empty")).toBeVisible();

  await page.getByTestId("analytics-demo").click();
  await expect(page.getByTestId("analytics-notice")).toHaveAttribute("data-kind", "ok", { timeout: 30_000 });

  const cards = page.getByTestId("kpi-card");
  const charts = page.getByTestId("line-chart").locator("svg");
  await expect(cards).toHaveCount(6);
  await expect(charts).toHaveCount(6);

  // The demo data carries injected incidents; the insights panel must surface them.
  const insights = page.getByTestId("insights-panel");
  await expect(insights.getByTestId("anomaly-row").first()).toBeVisible({ timeout: 30_000 });

  // Range 90 days: wait for the matching response so the assertions see the new data, not the old frame.
  let refreshed = dashboardResponse(page, 90, "day");
  await page.getByTestId("analytics-range-90").click();
  await refreshed;
  await expect(page.getByTestId("analytics-range-90")).toHaveAttribute("aria-checked", "true");

  refreshed = dashboardResponse(page, 90, "week");
  await page.getByTestId("analytics-bucket").selectOption("week");
  await refreshed;
  await expect(cards).toHaveCount(6);
  await expect(charts).toHaveCount(6);
  // Anomalies are daily, so weekly charts must drop their markers (the r=5 circles) rather than misplace them.
  await expect(page.getByTestId("line-chart").locator('circle[r="5"]')).toHaveCount(0);

  await page.getByTestId("analytics-table-toggle").check();
  await expect(page.getByTestId("kpi-table")).toHaveCount(6);
  await expect(page.getByTestId("line-chart")).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("analytics-export-xlsx").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(await download.failure()).toBeNull();
});
