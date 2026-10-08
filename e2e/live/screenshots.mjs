// Screenshots of the deployed demo (SITE), signed in through the one-click demo button.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const site = process.env.SITE.replace(/\/+$/, "");
const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
// Reduced motion: the Ask page then shows the answer at once and jumps instead of smooth-scrolling, so the
// shot never catches a half-typed answer (Playwright's animations: "disabled" does not stop JS timers).
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const shot = (name) => page.screenshot({ path: new URL(`${name}.png`, out).pathname, fullPage: true });

await page.goto(site, { waitUntil: "networkidle" });
await shot("1-landing");
await page.getByTestId("demo-login").click();
await page.waitForURL("**/dashboard/analytics");
await page.getByTestId("kpi-card").first().waitFor();
// Wait for the AI summary too, so the screenshot shows insights and anomaly markers, not the loading state.
await page.getByTestId("insights-summary").waitFor({ timeout: 30_000 });
await page.waitForLoadState("networkidle");
await shot("2-analytics");
await page.getByTestId("nav-documents").click();
await page.getByTestId("doc-row").first().waitFor();
await shot("3-documents");
await page.getByTestId("nav-ask").click();
await page.getByTestId("ask-input").fill("How long do customers have to request a refund?");
await page.getByTestId("ask-submit").click();
// "typing" only while the word-by-word reveal runs; a build from before data-typing has no attribute.
await page.locator('[data-testid="ask-answer"]:not([data-typing="typing"])').waitFor({ timeout: 30_000 });
await page.getByTestId("ask-source").first().waitFor();
await shot("4-ask");
await browser.close();
console.log("screenshots saved");
