import { setTimeout as sleep } from "node:timers/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { apiContext } from "./api";

/**
 * Browser side, installed with context.addInitScript so every document gets it. Playwright videos have no
 * mouse pointer, so a viewer could not tell what the tour is pointing at: this draws a dot that follows
 * the mouse and pulses on press. pointer-events:none keeps it out of hit-testing, so it never changes
 * what a click or hover lands on.
 */
export function fakeCursor(): void {
  const mount = () => {
    if (document.getElementById("demo-cursor")) return;
    const dot = document.createElement("div");
    dot.id = "demo-cursor";
    dot.setAttribute("aria-hidden", "true");
    // Dark ring plus white border: readable on white cards, indigo buttons and the dark nav pill alike.
    const ring = "0 0 0 1px rgba(24, 24, 27, 0.6), 0 2px 8px rgba(24, 24, 27, 0.35)";
    Object.assign(dot.style, {
      position: "fixed",
      left: "-11px",
      top: "-11px",
      width: "22px",
      height: "22px",
      boxSizing: "border-box", // keeps the centre on the hotspot: the border must not grow the box
      borderRadius: "50%",
      border: "2px solid #fff",
      // Translucent so an anomaly marker under the pointer still shows through.
      background: "rgba(79, 70, 229, 0.55)",
      boxShadow: `${ring}, 0 0 0 0 rgba(79, 70, 229, 0)`,
      pointerEvents: "none",
      zIndex: "2147483647",
      opacity: "0", // hidden until the first mousemove, instead of parked in the top-left corner
    });
    // <body>, not <html>: React 19 hydration skips unknown nodes in body rather than reporting a mismatch.
    document.body.appendChild(dot);
    addEventListener(
      "mousemove",
      (e) => {
        // A client-side re-render of the whole document (hydration fallback) would drop foreign nodes.
        if (!dot.isConnected) document.body.appendChild(dot);
        dot.style.translate = `${e.clientX}px ${e.clientY}px`;
        dot.style.opacity = "1";
      },
      { capture: true, passive: true },
    );
    addEventListener(
      "mousedown",
      () =>
        dot.animate(
          [
            { scale: "1", boxShadow: `${ring}, 0 0 0 0 rgba(79, 70, 229, 0.6)` },
            { scale: "0.7", offset: 0.25 },
            { scale: "1", boxShadow: `${ring}, 0 0 0 18px rgba(79, 70, 229, 0)` },
          ],
          { duration: 450, easing: "ease-out" },
        ),
      { capture: true },
    );
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

/** Runs `frame` with eased progress (0..1) for `ms` at about screen rate, so motion survives a 25 fps recording. */
async function tween(ms: number, frame: (p: number) => Promise<unknown>): Promise<void> {
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms);
    await frame(t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2); // easeInOutCubic
    if (t === 1) return;
    await sleep(16);
  }
}

/**
 * Drives a page the way a presenter would: eased pointer glides, visible presses, human-speed typing and
 * deliberate pauses. Waiting for the app still belongs to the caller's expect()s; sleeps here are pacing only.
 */
export class Tour {
  // Playwright does not expose the pointer position, and every glide needs a starting point.
  private x: number;
  private y: number;

  constructor(private readonly page: Page) {
    const { width, height } = page.viewportSize() ?? { width: 1280, height: 800 };
    this.x = width / 2;
    this.y = height * 0.75;
  }

  /** Puts the pointer on screen; until the first mousemove there is nothing to draw. */
  async enter(): Promise<void> {
    await this.page.mouse.move(this.x, this.y);
  }

  /** Viewing pause: the one place a fixed wait is the point. */
  async pause(ms: number): Promise<void> {
    await sleep(ms);
  }

  /**
   * Eased glide to a viewport point. A bare mouse.move({ steps }) sends every step within one video frame,
   * so the pointer would appear to teleport; pacing the steps in time is what makes the motion visible.
   */
  async glide(x: number, y: number, ms?: number): Promise<void> {
    const [x0, y0] = [this.x, this.y];
    const duration = ms ?? Math.min(900, 300 + Math.hypot(x - x0, y - y0) * 0.5);
    await tween(duration, (p) => this.page.mouse.move(x0 + (x - x0) * p, y0 + (y - y0) * p));
    [this.x, this.y] = [x, y];
  }

  async glideTo(target: Locator, ms?: number): Promise<void> {
    await this.reveal(target);
    const box = await target.boundingBox();
    if (!box) throw new Error(`${target} has no layout box`);
    await this.glide(box.x + box.width / 2, box.y + box.height / 2, ms);
  }

  async click(target: Locator): Promise<void> {
    await this.glideTo(target);
    await sleep(150); // let the eye land before the press
    // Clicks the box centre, where the glide ended, and still gets Playwright's actionability checks.
    await target.click();
  }

  async type(target: Locator, text: string, delay = 50): Promise<void> {
    await this.click(target);
    await target.pressSequentially(text, { delay });
  }

  /** Smooth-scrolls only when `target` is not fully in view, lining `anchor` (default: target) up near the top. */
  async reveal(target: Locator, anchor: Locator = target): Promise<void> {
    const inView = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    if (inView) return;
    const to = await anchor.evaluate((el) => {
      // Clamped up front: a tween aimed past the end of the page would stall at the edge and look like a jerk.
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return Math.max(0, Math.min(max, el.getBoundingClientRect().top + window.scrollY - 24));
    });
    await this.scrollTo(to);
  }

  /** Stepped from here rather than behavior:"smooth", whose speed depends on the browser and is not awaitable. */
  async scrollTo(to: number, ms = 700): Promise<void> {
    const from = await this.page.evaluate(() => window.scrollY);
    if (Math.abs(to - from) < 1) return;
    await tween(ms, (p) => this.page.evaluate((y) => window.scrollTo(0, y), from + (to - from) * p));
  }
}

/**
 * seedDemo.ts inserts the demo documents and queues them for indexing, then exits. Waiting here, before the
 * recording starts, keeps the Ask step from filming "nothing found" while the worker is still busy.
 */
export async function waitForDemoDocuments(email: string, password: string): Promise<void> {
  const anon = await apiContext();
  const res = await anon.post("auth/login", { data: { email, password } });
  expect(res.status(), `demo login failed: ${await res.text()}`).toBe(200);
  const { token } = await res.json();
  await anon.dispose();

  const api = await apiContext(token);
  // "ready:4" once done; while not, the status mix ("processing:1,ready:3") is the failure message.
  await expect
    .poll(
      async () => {
        const { data } = (await (await api.get("documents")).json()) as { data: { status: string }[] };
        const counts = new Map<string, number>();
        for (const d of data) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
        return [...counts].map(([s, n]) => `${s}:${n}`).sort().join(",") || "none";
      },
      { message: "demo documents indexed", timeout: 90_000, intervals: [1000] },
    )
    .toMatch(/^ready:\d+$/);
  await api.dispose();
}
