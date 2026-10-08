import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AskBody } from "../src/schemas.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

// AI_RATE_LIMIT is read when the modules load, hence resetModules + dynamic imports with it set.
async function loadApp(env: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(process.env, env);
  const { createApp } = await import("../src/app.js");
  const db = (await import("../src/lib/db.js")) as unknown as typeof import("./helpers/fakeDb.js");
  return { app: createApp(), bearer: db.bearer };
}

afterEach(() => {
  delete process.env.AI_RATE_LIMIT;
  vi.doUnmock("../src/lib/aiClient.js");
  vi.doUnmock("../src/lib/audit.js");
});

describe("ask history", () => {
  const turn = (i: number) => ({ question: `question ${i}`, answer: `answer ${i}` });

  it("accepts up to 4 turns of up to 2,000 characters and drops turns without a question", () => {
    expect(AskBody.parse({ question: "q" }).history).toEqual([]);
    const parsed = AskBody.parse({
      question: "and for express?",
      history: [turn(1), { question: "  ", answer: "orphan" }, { question: "q", answer: "" }],
    });
    expect(parsed.history).toEqual([turn(1), { question: "q", answer: "" }]);
    expect(AskBody.safeParse({ question: "q", history: [1, 2, 3, 4, 5].map(turn) }).success).toBe(false);
    expect(AskBody.safeParse({ question: "q", history: [{ question: "x".repeat(2001), answer: "" }] }).success).toBe(
      false,
    );
    expect(AskBody.safeParse({ question: "q", history: [{ question: "q", answer: "x".repeat(2001) }] }).success).toBe(
      false,
    );
    expect(AskBody.safeParse({ question: "q", history: [{ question: "q" }] }).success).toBe(false);
  });

  it("forwards the history to the AI service and passes its retrieval query back", async () => {
    const aiPost = vi.fn(async () => ({
      status: 200,
      data: { answer: "Next day [1].", provider: "extractive", ms: 5, retrieval_query: "express delivery time", citations: [] },
    }));
    vi.doMock("../src/lib/aiClient.js", () => ({ aiPost }));
    vi.doMock("../src/lib/audit.js", () => ({ audit: async () => {} }));
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "0" });
    const auth = bearer("viewer", { sub: "asker" });

    const res = await request(app)
      .post("/api/v1/ask")
      .set("authorization", auth)
      .send({ question: "and for express?", history: [turn(1), turn(2)] })
      .expect(200);
    expect(aiPost).toHaveBeenCalledWith("/v1/ask", {
      tenant_id: "t1",
      question: "and for express?",
      top_k: 5,
      history: [turn(1), turn(2)],
    });
    expect(res.body).toMatchObject({ answer: "Next day [1].", retrievalQuery: "express delivery time" });

    aiPost.mockClear();
    await request(app).post("/api/v1/ask").set("authorization", auth).send({ question: "first question" });
    // No history key at all for a first question: the request stays exactly what it was before.
    expect(aiPost.mock.calls[0]).toEqual(["/v1/ask", { tenant_id: "t1", question: "first question", top_k: 5 }]);
  });

  it("rejects a sixth turn before any AI call", async () => {
    const aiPost = vi.fn();
    vi.doMock("../src/lib/aiClient.js", () => ({ aiPost }));
    const { app, bearer } = await loadApp({ AI_RATE_LIMIT: "0" });
    await request(app)
      .post("/api/v1/ask")
      .set("authorization", bearer("viewer", { sub: "asker2" }))
      .send({ question: "q", history: [1, 2, 3, 4, 5].map(turn) })
      .expect(400);
    expect(aiPost).not.toHaveBeenCalled();
  });
});
