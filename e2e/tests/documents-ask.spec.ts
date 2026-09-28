import { expect, test } from "@playwright/test";
import { registerOwner, useToken } from "../support/api";
import { REFUND_POLICY, REFUND_QUESTION } from "../support/docs";

test("upload a policy, wait for indexing, get a cited answer", async ({ page }) => {
  const owner = await registerOwner("docs");
  await useToken(page, owner.token);

  await page.goto("/dashboard/documents");
  await expect(page.getByTestId("doc-empty")).toBeVisible();

  // In-memory file: no fixture on disk, and the input is visually hidden but still accepts files.
  await page.getByTestId("doc-upload-input").setInputFiles({
    name: REFUND_POLICY.filename,
    mimeType: "text/plain",
    buffer: Buffer.from(REFUND_POLICY.body, "utf8"),
  });
  await expect(page.getByTestId("doc-upload-filename")).toHaveText(REFUND_POLICY.filename);
  await page.getByTestId("doc-upload-submit").click();

  const row = page.getByTestId("doc-row");
  await expect(row).toHaveCount(1);
  // The page polls every 2s while a document is queued/processing; the worker indexes it in the background.
  await expect(row.getByTestId("doc-status")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

  await page.getByTestId("nav-ask").click();
  await expect(page).toHaveURL(/\/dashboard\/ask$/);
  await page.getByTestId("ask-input").fill(REFUND_QUESTION);
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-answer")).toBeVisible({ timeout: 30_000 });
  // "30" comes from the uploaded document, so this proves retrieval, not just a rendered response.
  await expect(page.getByTestId("ask-answer")).toContainText("30");
  await expect(page.getByTestId("ask-sources")).toBeVisible();
  expect(await page.getByTestId("ask-source").count()).toBeGreaterThanOrEqual(1);
});
