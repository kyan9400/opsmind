import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
// Screenshot runs regenerate README images; they are opt-in so a normal run never rewrites docs/.
const SCREENSHOTS = process.env.SCREENSHOTS === "1";
// Same for the README demo video (tests/demo-video.spec.ts), which also needs the seeded demo login.
const DEMO_VIDEO = process.env.DEMO_VIDEO === "1";
// Each flag runs only its own suite; a normal run leaves every opt-in suite out.
const ONLY = DEMO_VIDEO ? /@demo/ : SCREENSHOTS ? /@screenshots/ : undefined;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Every test owns its tenant, so parallel workers never share state; two keeps the worker/AI queue calm on CI runners.
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "on-failure" }]],
  grep: ONLY,
  grepInvert: ONLY ? undefined : /@screenshots|@demo/,
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3000",
    // Pin the browser language so the server-side Accept-Language negotiation always starts in English.
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
