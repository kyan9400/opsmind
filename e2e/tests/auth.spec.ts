import { expect, test } from "@playwright/test";
import { PASSWORD, registerOwner, uniqueEmail } from "../support/api";

test("register a workspace, sign out, sign back in", async ({ page }) => {
  const email = uniqueEmail("auth");
  const name = "Ada Tester";

  await page.goto("/");
  await page.getByTestId("landing-register").click();
  await expect(page.getByTestId("login-tenant")).toBeVisible();
  await page.getByTestId("login-tenant").fill("Auth Spec Co");
  await page.getByTestId("login-name").fill(name);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();

  await expect(page).toHaveURL(/\/dashboard$/);
  // The user's own name is data, not a translation, so it is safe to assert on.
  await expect(page.getByTestId("overview-welcome")).toContainText(name);
  await expect(page.getByTestId("team-list").locator("[data-role=owner]")).toHaveCount(1);

  await page.getByTestId("nav-signout").click();
  await expect(page).toHaveURL(/\/login$/);
  // Signed out means the token is gone: the dashboard must bounce back to the login page.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("overview-welcome")).toContainText(name);
});

test("wrong password shows an error and stays on the login page", async ({ page }) => {
  const owner = await registerOwner("auth-bad");

  await page.goto("/login");
  await page.getByTestId("login-email").fill(owner.email);
  await page.getByTestId("login-password").fill("not-the-password");
  await page.getByTestId("login-submit").click();

  await expect(page.getByTestId("login-error")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
