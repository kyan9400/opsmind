import { expect, test, type Page } from "@playwright/test";
import { apiContext, createUser, loadDemoKpis, readToken, registerOwner } from "../support/api";

// Role-gated controls render only after /auth/me resolves; asserting absence before that would pass vacuously.
const meLoaded = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/me") && r.ok());

test("a viewer can look but not change anything", async ({ page }) => {
  const owner = await registerOwner("rbac");
  await loadDemoKpis(owner);
  const viewer = await createUser(owner, "viewer");

  await page.goto("/login");
  await page.getByTestId("login-email").fill(viewer.email);
  await page.getByTestId("login-password").fill(viewer.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("overview-welcome")).toContainText(viewer.name);
  await expect(page.getByTestId("add-member-form")).toHaveCount(0);

  let me = meLoaded(page);
  await page.getByTestId("nav-documents").click();
  await me;
  await expect(page.getByTestId("doc-table")).toBeVisible();
  await expect(page.getByTestId("doc-upload-form")).toHaveCount(0);
  await expect(page.getByTestId("doc-upload-input")).toHaveCount(0);

  me = meLoaded(page);
  await page.getByTestId("nav-analytics").click();
  await me;
  await expect(page.getByTestId("kpi-card")).toHaveCount(6);
  // Exports stay available to viewers (positive control that the toolbar rendered at all).
  await expect(page.getByTestId("analytics-export-xlsx")).toBeVisible();
  await expect(page.getByTestId("analytics-demo")).toHaveCount(0);
  await expect(page.getByTestId("analytics-import")).toHaveCount(0);

  // Hidden buttons are UX; the API is the real boundary. Reuse the viewer's own session token.
  const token = await readToken(page);
  expect(token).toBeTruthy();
  const api = await apiContext(token!);
  expect((await api.post("metrics/demo")).status()).toBe(403);
  await api.dispose();
});
