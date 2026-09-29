import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

// Limits are read from the environment when the app modules load, hence resetModules + dynamic imports.
async function loadApp(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, env);
  const { createApp } = await import("../src/app.js");
  // The fake db instance this app was built with (a direct import of the helper may be a fresh copy).
  const { bearer } = (await import("../src/lib/db.js")) as unknown as typeof import("./helpers/fakeDb.js");
  return { app: createApp(), bearer };
}

afterEach(() => {
  delete process.env.AUTH_RATE_LIMIT;
  delete process.env.AI_RATE_LIMIT;
  delete process.env.TRUST_PROXY;
});

describe("credential rate limit", () => {
  it("blocks brute force on login after the per-IP budget", async () => {
    const { app } = await loadApp({ AUTH_RATE_LIMIT: "3" });
    // Invalid bodies fail validation before touching the database, but still count as attempts.
    for (let i = 0; i < 3; i++) await request(app).post("/api/v1/auth/login").send({}).expect(400);
    const blocked = await request(app).post("/api/v1/auth/login").send({}).expect(429);
    expect(blocked.body.error).toMatch(/too many attempts/);
    // Other endpoints are not affected.
    await request(app).get("/health").expect(200);
  });
});

describe("AI rate limit", () => {
  it("caps AI-backed requests per user and IP, shared by ask, insights and exports", async () => {
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "3" });
    const alice = bearer("viewer", { sub: "alice" });
    const bob = bearer("viewer", { sub: "bob" });
    // Invalid input is rejected before the AI call, but the request still spends the budget.
    await request(app).post("/api/v1/ask").set("authorization", alice).send({ question: "" }).expect(400);
    await request(app).get("/api/v1/metrics/insights?days=1000").set("authorization", alice).expect(400);
    await request(app).get("/api/v1/metrics/export?format=docx").set("authorization", alice).expect(400);
    const blocked = await request(app).post("/api/v1/ask").set("authorization", alice).send({ question: "" }).expect(429);
    expect(blocked.body.error).toMatch(/too many AI requests/);
    await request(app).get("/api/v1/metrics/insights?days=1000").set("authorization", alice).expect(429);

    // Same IP, another user: a budget of its own. Endpoints without AI calls are not limited.
    await request(app).post("/api/v1/ask").set("authorization", bob).send({ question: "" }).expect(400);
    await request(app).get("/api/v1/metrics/dashboard?days=1000").set("authorization", alice).expect(400);
  });

  it("gives each client IP on a shared login its own budget, under an account-wide ceiling", async () => {
    // Demo visitors all sign in as the same viewer; behind the proxy (TRUST_PROXY=1) their IPs differ.
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "1", TRUST_PROXY: "1" });
    const demo = bearer("viewer", { sub: "demo" });
    const ask = (ip: string, auth = demo) =>
      request(app).post("/api/v1/ask").set("authorization", auth).set("x-forwarded-for", ip).send({ question: "" });

    const first = await ask("203.0.113.1").expect(400);
    // The headers describe the visitor's budget, not the account-wide one.
    expect(first.headers.ratelimit).toMatch(/^limit=1, remaining=0\b/);
    const blocked = await ask("203.0.113.1").expect(429);
    expect(blocked.body.error).toBe("too many AI requests, try again in a minute");

    // Nine more visitors on the same login each get their own request...
    for (let i = 2; i <= 10; i++) await ask(`203.0.113.${i}`).expect(400);
    // ...and then the account as a whole (10x the per-visitor budget) is used up, whatever the IP.
    const capped = await ask("203.0.113.11").expect(429);
    expect(capped.body.error).toMatch(/on this account/);
    // Other accounts keep their own budgets.
    await ask("203.0.113.11", bearer("viewer", { sub: "other" })).expect(400);
  });

  it("is disabled by AI_RATE_LIMIT=0", async () => {
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "0" });
    const auth = bearer("viewer");
    for (let i = 0; i < 25; i++) {
      await request(app).post("/api/v1/ask").set("authorization", auth).send({ question: "" }).expect(400);
    }
  });

  it("does not count requests rejected by authentication", async () => {
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "1" });
    for (let i = 0; i < 3; i++) await request(app).post("/api/v1/ask").send({ question: "" }).expect(401);
    await request(app).post("/api/v1/ask").set("authorization", bearer("viewer")).send({ question: "" }).expect(400);
  });
});
