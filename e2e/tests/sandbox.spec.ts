import { expect, test } from "@playwright/test";

// Needs the sandbox switched on for the API and baked into the web build (ALLOW_SANDBOX=true for
// docker compose; the browser CI job sets it). Elsewhere the button is not rendered, so the spec skips.
test.skip(process.env.ALLOW_SANDBOX !== "true", "sandbox is off (set ALLOW_SANDBOX=true for the stack and this run)");

const PARKING = {
  name: "parking-policy.txt",
  body: `Parking policy

Visitors park on level 2 of the north garage.
The barrier opens with a staff badge after 18:00.`,
};

test("try it with your own data: create a sandbox, upload a file, ask about it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sandbox-start").click();
  await page.waitForURL("**/dashboard/documents");

  const banner = page.getByTestId("sandbox-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/deleted in 2[34] hours/);
  await expect(page.getByTestId("sidebar-account")).toContainText("Sandbox workspace");

  // The four sample documents are there from the start; the visitor is the owner and can upload.
  const rows = page.getByTestId("doc-row");
  await expect(rows).toHaveCount(4);
  await page.getByTestId("doc-upload-input").setInputFiles({
    name: PARKING.name,
    mimeType: "text/plain",
    buffer: Buffer.from(PARKING.body, "utf8"),
  });
  await page.getByTestId("doc-upload-submit").click();
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: /parking/i }).getByTestId("doc-status")).toHaveAttribute("data-status", "ready", {
    timeout: 60_000,
  });

  await page.getByTestId("nav-ask").click();
  await page.getByTestId("ask-input").fill("Where do visitors park?");
  await page.getByTestId("ask-submit").click();
  // "level 2" exists only in the uploaded file: the answer comes from the visitor's own data.
  await expect(page.getByTestId("ask-answer")).toContainText("level 2", { timeout: 30_000 });
  await expect(page.getByTestId("ask-sources")).toContainText(/parking/i);
  await expect(banner).toBeVisible();

  // A sandbox is for one visitor: no invite form on the overview.
  await page.getByTestId("nav-overview").click();
  await expect(page.getByTestId("overview-welcome")).toBeVisible();
  await expect(page.getByTestId("add-member-form")).toHaveCount(0);
});
