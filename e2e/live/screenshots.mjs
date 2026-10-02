// Screenshots of the deployed demo (SITE), signed in through the one-click demo button.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const site = process.env.SITE.replace(/\/+$/, "");
const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = (name) => page.screenshot({ path: new URL(`${name}.png`, out).pathname, fullPage: true });

await page.goto(site, { waitUntil: "networkidle" });
await shot("1-landing");
await page.getByTestId("demo-login").click();
await page.waitForURL("**/dashboard/analytics");
await page.getByTestId("kpi-card").first().waitFor();
await page.waitForLoadState("networkidle");
await shot("2-analytics");
await page.getByTestId("nav-documents").click();
await page.getByTestId("doc-row").first().waitFor();
await shot("3-documents");
await page.getByTestId("nav-ask").click();
await page.getByTestId("ask-input").fill("How long do customers have to request a refund?");
await page.getByTestId("ask-submit").click();
await page.getByTestId("ask-answer").waitFor();
await shot("4-ask");
await browser.close();
console.log("screenshots saved");
