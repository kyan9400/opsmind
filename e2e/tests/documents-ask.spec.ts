import { expect, test } from "@playwright/test";
import { registerOwner, uploadDocuments, useToken } from "../support/api";
import { REFUND_POLICY, REFUND_QUESTION, SAMPLE_DOCS } from "../support/docs";

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

test("a follow-up question continues the conversation and sends it as history", async ({ page }) => {
  const owner = await registerOwner("chat");
  await uploadDocuments(owner, SAMPLE_DOCS.slice(0, 2));
  await useToken(page, owner.token);

  const isAsk = (url: string) => new URL(url).pathname.endsWith("/api/v1/ask");
  await page.goto("/dashboard/ask");
  const firstResponse = page.waitForResponse((r) => r.request().method() === "POST" && isAsk(r.url()));
  await page.getByTestId("ask-input").fill(REFUND_QUESTION);
  await page.getByTestId("ask-submit").click();
  const firstAnswer = ((await (await firstResponse).json()) as { answer: string }).answer;
  await expect(page.getByTestId("ask-answer")).toContainText("30", { timeout: 30_000 });

  const followUp = "And how fast do orders ship?";
  const request = page.waitForRequest((r) => r.method() === "POST" && isAsk(r.url()));
  await page.getByTestId("ask-input").fill(followUp);
  await page.getByTestId("ask-submit").click();
  const sent = (await request).postDataJSON();
  expect(sent.question).toBe(followUp);
  // The first exchange, verbatim, as the API returned it.
  expect(sent.history).toEqual([{ question: REFUND_QUESTION, answer: firstAnswer }]);

  // Both turns stay on screen; only the newest answer carries the original test ids.
  const thread = page.getByTestId("ask-thread");
  await expect(thread.getByTestId("ask-turn")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("ask-answer")).toHaveCount(1);
  await expect(page.getByTestId("ask-sources")).toContainText(/shipping/i);
  await expect(page.getByTestId("ask-copy")).toHaveCount(2);

  // The conversation survives a reload of the tab, and New chat clears it.
  await page.reload();
  await expect(thread.getByTestId("ask-turn")).toHaveCount(2);
  await page.getByTestId("ask-new-chat").click();
  await expect(thread.getByTestId("ask-turn")).toHaveCount(0);
  await expect(page.getByTestId("ask-example-1")).toBeVisible();
});
