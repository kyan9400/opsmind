import { expect, test, type Page, type Route } from "@playwright/test";
import { ar } from "../../apps/web/lib/i18n/ar";
import { en } from "../../apps/web/lib/i18n/en";
import { useToken } from "../support/api";

/**
 * The Ask page's rendering, scrolling and accessibility, with the API stubbed inside the browser: each case
 * controls the exact answer (Markdown as an LLM writes it, many sources, a rewritten follow-up query)
 * without an LLM, indexed documents or a real account.
 */

const ME = {
  id: "u-ui",
  email: "ask-ui@example.com",
  name: "Ask UI",
  role: "owner",
  tenantId: "t-ui",
  tenantName: "Ask UI Co",
  expiresAt: null as string | null,
};

interface Stubbed {
  answer: string;
  sources?: number;
  retrievalQuery?: string;
}

const citation = (n: number) => ({
  n,
  documentId: `doc-${n}`,
  title: `Policy ${n}`,
  chunkIndex: 0,
  snippet: `Source ${n} says something relevant about the question. `.repeat(4),
  score: 0.9 - n / 20,
  cited: n <= 2,
});

// The browser calls the API on another origin unless the build proxies it, so the stub answers CORS too.
const reply = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

async function stubApi(page: Page, answers: Stubbed[], me = ME) {
  let next = 0;
  await page.route("**/api/v1/auth/me", (route) => reply(route, me));
  await page.route("**/api/v1/ask", (route) => {
    const a = answers[Math.min(next++, answers.length - 1)];
    return reply(route, {
      answer: a.answer,
      citations: Array.from({ length: a.sources ?? 2 }, (_, i) => citation(i + 1)),
      provider: "openai-compatible",
      ms: 420,
      ...(a.retrievalQuery && { retrievalQuery: a.retrievalQuery }),
    });
  });
  await useToken(page, "stubbed-token-for-ask-ui");
}

async function ask(page: Page, question: string) {
  await page.getByTestId("ask-input").fill(question);
  await page.getByTestId("ask-submit").click();
}

const MARKDOWN = [
  "## Refunds",
  "Customers get a **full refund within 30 days** [1].",
  "",
  "- The item must be *unused* [1]",
  "- After that: store credit, code `CREDIT-90` [2]",
  "",
  'Raw HTML stays text: <img src="x" onerror="window.__xss = 1">',
].join("\n");

test("renders the Markdown an LLM writes, keeps citation chips and never renders raw HTML", async ({ page }) => {
  await stubApi(page, [{ answer: MARKDOWN }]);
  await page.goto("/dashboard/ask");
  await ask(page, "What is the refund policy?");

  const answer = page.getByTestId("ask-answer");
  await expect(answer).toHaveAttribute("data-typing", "done", { timeout: 15_000 });
  await expect(answer.locator("p").first()).toHaveText("Refunds");
  await expect(answer.locator("strong")).toHaveText("full refund within 30 days");
  await expect(answer.locator("em")).toHaveText("unused");
  await expect(answer.locator("code")).toHaveText("CREDIT-90");
  await expect(answer.locator("ul > li")).toHaveCount(2);
  await expect(answer).not.toContainText("**");
  await expect(answer).not.toContainText("##");
  await expect(answer).toContainText('<img src="x" onerror="window.__xss = 1">');
  await expect(answer.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();

  const chips = answer.locator('a[href^="#source-"]');
  await expect(chips).toHaveCount(3);
  await chips.last().click();
  await expect(page).toHaveURL(/#source-.+-2$/);
  await expect(page.getByTestId("ask-source").nth(1)).toBeInViewport();
});

test("announces the whole answer once, hides the half-typed text and gives focus back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const text = "The first sentence has **bold words** [1]. The second sentence adds a few more words to reveal [2].";
  await stubApi(page, [{ answer: text }]);
  await page.goto("/dashboard/ask");

  // What a screen reader would be sent (every text of the live region) and what the answer looked like to
  // assistive tech at each step of the reveal.
  await page.evaluate(() => {
    const w = window as unknown as { announced: string[]; states: string[] };
    w.announced = [];
    w.states = [];
    const live = document.querySelector('[data-testid="ask-live"]')!;
    new MutationObserver(() => w.announced.push(live.textContent ?? "")).observe(live, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="ask-answer"]');
      if (!el) return;
      const full = Array.from(el.parentElement!.querySelectorAll("p.sr-only")).some((p) =>
        p.textContent?.includes("to reveal [2]."),
      );
      w.states.push(`${el.getAttribute("data-typing")} hidden=${el.getAttribute("aria-hidden")} full=${full}`);
    }).observe(document.querySelector('[data-testid="ask-thread"]')!, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });

  await ask(page, "Tell me about it");
  await expect(page.getByTestId("ask-answer")).toHaveAttribute("data-typing", "done", { timeout: 15_000 });

  const { announced, states } = await page.evaluate(() => {
    const w = window as unknown as { announced: string[]; states: string[] };
    return { announced: w.announced, states: w.states };
  });
  const plain = "The first sentence has bold words [1]. The second sentence adds a few more words to reveal [2].";
  expect(announced.filter(Boolean)).toEqual([en["ask.thinking"], `${en["ask.answer"]}: ${plain}`]);
  // While typing, the visible text is hidden and the full answer is there instead; afterwards, only the answer.
  expect(states).toContain("typing hidden=true full=true");
  expect(states.at(-1)).toBe("done hidden=null full=false");

  await expect(page.getByTestId("ask-input")).toBeFocused();

  await page.getByTestId("ask-copy").click();
  await expect(page.getByTestId("ask-copy-status")).toHaveText(en["ask.copied"]);
});

test("isolates the rewritten search query inside the Arabic label", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "opsmind.locale", value: "ar", url: baseURL! }]);
  const query = "How fast do orders ship? How many days for a refund?";
  await stubApi(page, [{ answer: "Orders ship the same day [1].", retrievalQuery: query }]);
  await page.goto("/dashboard/ask");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await ask(page, "And shipping?");

  const searched = page.getByTestId("ask-searched");
  await expect(searched.locator("bdi")).toHaveText(query);
  await expect(searched).toHaveText(ar["ask.searchedFor"].replace("{query}", query));
});

test.describe("on a phone", () => {
  // Reduced motion: the answer appears at once and the page jumps, so positions can be read right away.
  test.use({ viewport: { width: 360, height: 740 }, reducedMotion: "reduce" });

  test("a new answer is scrolled to its start, not to the end of its sources", async ({ page }) => {
    const long = "Refunds are accepted within 30 days of delivery when the item is unused [1]. ".repeat(3);
    await stubApi(page, [
      { answer: long, sources: 6 },
      { answer: `And for shipping: ${long}`, sources: 6 },
    ]);
    await page.goto("/dashboard/ask");
    await ask(page, "How long do customers have to request a refund?");
    // With reduced motion there is no reveal: the first state of the answer is already complete.
    await page.getByTestId("ask-answer").waitFor();
    expect(await page.getByTestId("ask-answer").getAttribute("data-typing")).toBe("done");

    await ask(page, "And shipping?");
    await expect(page.getByTestId("ask-turn")).toHaveCount(2);
    await expect(page.getByTestId("ask-answer")).toContainText("And for shipping");

    const turn = await page.getByTestId("ask-turn").last().boundingBox();
    expect(turn, "the new turn has a layout box").not.toBeNull();
    // Just below the 56 px sticky top bar (scroll-mt-28 leaves room for the sandbox banner as well).
    expect(turn!.y).toBeGreaterThanOrEqual(56);
    expect(turn!.y).toBeLessThan(160);
    await expect(page.getByTestId("ask-answer")).toBeInViewport();
  });
});
