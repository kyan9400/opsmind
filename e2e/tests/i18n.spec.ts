import { expect, test } from "@playwright/test";
// The dictionaries are the source of truth; importing them keeps this spec in step with copy edits.
import { ar } from "../../apps/web/lib/i18n/ar";
import { en } from "../../apps/web/lib/i18n/en";
import { ru } from "../../apps/web/lib/i18n/ru";
import { registerOwner, useToken } from "../support/api";

test("switch to Russian, then Arabic (RTL), and keep it across reloads", async ({ page }) => {
  const owner = await registerOwner("i18n");
  await useToken(page, owner.token);

  const html = page.locator("html");
  const nav = page.getByTestId("nav-analytics");

  await page.goto("/dashboard");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(nav).toHaveText(en["nav.analytics"]);

  await page.getByTestId("lang-ru").click();
  await expect(html).toHaveAttribute("lang", "ru");
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(nav).toHaveText(ru["nav.analytics"]);
  await expect(page.getByTestId("nav-signout")).toHaveText(ru["nav.signOut"]);
  await expect(page.getByTestId("lang-ru")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("lang-ar").click();
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(nav).toHaveText(ar["nav.analytics"]);
  await expect(page.getByTestId("nav-signout")).toHaveText(ar["nav.signOut"]);

  // The choice is stored in a cookie, so the server renders the next first paint in Arabic/RTL already.
  const response = await page.reload();
  const serverHtml = (await response?.text()) ?? "";
  expect(serverHtml).toMatch(/<html[^>]*\blang="ar"/);
  expect(serverHtml).toMatch(/<html[^>]*\bdir="rtl"/);
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(nav).toHaveText(ar["nav.analytics"]);

  // Still Arabic on another page (client-side navigation keeps the provider state).
  await page.getByTestId("nav-documents").click();
  await expect(page).toHaveURL(/\/dashboard\/documents$/);
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("nav-documents")).toHaveText(ar["nav.documents"]);
});
