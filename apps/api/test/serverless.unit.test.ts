import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

// The serverless profile (deploy/vercel) is switched on by environment variables that are read when the
// modules load, hence resetModules + dynamic imports with the variables set.
const VARS = [
  "INGEST_MODE",
  "REDIS_URL",
  "ALLOW_REGISTRATION",
  "METRICS_PUBLIC",
  "CRON_SECRET",
  "AI_SERVICE_URL",
  "DEMO_EMAIL",
  "DEMO_PASSWORD",
  "PG_POOL_MAX",
  "MAX_UPLOAD_BYTES",
];
// Every test starts without them, whatever the shell or CI job exported (the api job sets REDIS_URL),
// and the file puts the originals back when it is done.
const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
const clearVars = () => VARS.forEach((name) => delete process.env[name]);

async function load<T>(path: string, env: Record<string, string> = {}): Promise<T> {
  vi.resetModules();
  Object.assign(process.env, env);
  return import(path) as Promise<T>;
}
const loadApp = (env: Record<string, string> = {}) => load<typeof import("../src/app.js")>("../src/app.js", env);
const loadConfig = (env: Record<string, string> = {}) =>
  load<typeof import("../src/config.js")>("../src/config.js", env).then((m) => m.config);

beforeEach(() => {
  clearVars();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  clearVars();
  for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
});

afterEach(() => {
  vi.doUnmock("../src/lib/aiClient.js");
  vi.doUnmock("../src/lib/demoSeed.js");
  vi.doUnmock("../src/lib/sandbox.js");
  vi.doUnmock("../src/lib/ingest.js");
  vi.doUnmock("../src/lib/queue.js");
  vi.doUnmock("../src/lib/metrics.js");
  vi.doUnmock("../src/lib/redis.js");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Vercel entry", () => {
  it("default-exports a ready Express app, and createApp() still works alongside it", async () => {
    const { default: app, createApp } = await loadApp();
    expect(typeof app).toBe("function");
    await request(app).get("/health").expect(200, { status: "ok" });
    await request(createApp()).get("/health").expect(200);
  });
});

describe("config", () => {
  it("needs no Redis in inline mode and keeps the local default in queue mode", async () => {
    expect((await loadConfig({ INGEST_MODE: "inline" })).REDIS_URL).toBeUndefined();
    expect((await loadConfig({ INGEST_MODE: "inline", REDIS_URL: "rediss://u:p@cache:6380" })).REDIS_URL).toBe(
      "rediss://u:p@cache:6380",
    );
    delete process.env.INGEST_MODE;
    // A field cleared in a hosting dashboard arrives as "", which means unset.
    expect((await loadConfig({ REDIS_URL: "" })).REDIS_URL).toBe("redis://localhost:6379");
  });

  it("reads on/off switches strictly, with the old behaviour as the default", async () => {
    const defaults = await loadConfig();
    expect([defaults.ALLOW_REGISTRATION, defaults.METRICS_PUBLIC, defaults.INGEST_MODE]).toEqual([true, true, "queue"]);
    const off = await loadConfig({ ALLOW_REGISTRATION: "FALSE", METRICS_PUBLIC: "0" });
    expect([off.ALLOW_REGISTRATION, off.METRICS_PUBLIC]).toEqual([false, false]);
    await expect(loadConfig({ METRICS_PUBLIC: "no" })).rejects.toThrow();
  });

  it("reads a blank number as unset, not as 0", async () => {
    const blank = await loadConfig({ PG_POOL_MAX: "", MAX_UPLOAD_BYTES: " " });
    expect([blank.PG_POOL_MAX, blank.MAX_UPLOAD_BYTES]).toEqual([10, 10 * 1024 * 1024]);
    const set = await loadConfig({ PG_POOL_MAX: "3", MAX_UPLOAD_BYTES: "4194304" });
    expect([set.PG_POOL_MAX, set.MAX_UPLOAD_BYTES]).toEqual([3, 4194304]);
    await expect(loadConfig({ PG_POOL_MAX: "0" })).rejects.toThrow();
  });

  it("drops a trailing slash from AI_SERVICE_URL", async () => {
    expect((await loadConfig({ AI_SERVICE_URL: "https://ai.example.app/" })).AI_SERVICE_URL).toBe(
      "https://ai.example.app",
    );
  });
});

describe("public deploy switches", () => {
  it("ALLOW_REGISTRATION=false answers sign-up with a clear 403", async () => {
    const { createApp } = await loadApp({ ALLOW_REGISTRATION: "false" });
    const res = await request(createApp())
      .post("/api/v1/auth/register")
      .send({ tenantName: "Acme", name: "A", email: "a@acme.io", password: "password123" })
      .expect(403);
    expect(res.body.error).toMatch(/registration is disabled/);
  });

  it("METRICS_PUBLIC=false removes /metrics", async () => {
    const { createApp } = await loadApp({ METRICS_PUBLIC: "false" });
    await request(createApp()).get("/metrics").expect(404);
    await request(createApp()).get("/health").expect(200);
  });
});

describe("cron seed route", () => {
  const SECRET = "cron-secret-0123456789";

  it("does not exist without CRON_SECRET", async () => {
    const { createApp } = await loadApp();
    await request(createApp()).get("/api/internal/cron/seed").set("authorization", `Bearer ${SECRET}`).expect(404);
  });

  it("runs the seed and the sandbox cleanup only for the exact bearer secret", async () => {
    const seedDemo = vi.fn(async () => ({ msg: "demo workspace ready" }));
    const deleteExpiredSandboxes = vi.fn(async () => 2);
    vi.doMock("../src/lib/demoSeed.js", () => ({ seedDemo, demoSeedOptions: () => ({}) }));
    vi.doMock("../src/lib/sandbox.js", () => ({ deleteExpiredSandboxes, createSandbox: vi.fn() }));
    const { createApp } = await loadApp({ CRON_SECRET: SECRET });
    const app = createApp();
    const seed = () => request(app).get("/api/internal/cron/seed");

    await seed().expect(401);
    await seed().set("authorization", "Bearer wrong").expect(401);
    await seed().set("authorization", SECRET).expect(401); // the Bearer prefix is part of the contract
    await seed().set("authorization", `Bearer ${SECRET}x`).expect(401);
    expect(seedDemo).not.toHaveBeenCalled();
    expect(deleteExpiredSandboxes).not.toHaveBeenCalled();

    await seed()
      .set("authorization", `Bearer ${SECRET}`)
      .expect(200, { msg: "demo workspace ready", sandboxesDeleted: 2 });
    expect(seedDemo).toHaveBeenCalledTimes(1);
    expect(deleteExpiredSandboxes).toHaveBeenCalledTimes(1);
  });

  it("explains a missing demo login instead of failing validation", async () => {
    const { demoSeedOptions } = await load<typeof import("../src/lib/demoSeed.js")>("../src/lib/demoSeed.js");
    expect(() => demoSeedOptions({ DEMO_EMAIL: "demo@opsmind.dev" })).toThrow(/DEMO_EMAIL and DEMO_PASSWORD/);
    expect(demoSeedOptions({ DEMO_EMAIL: " Demo@OpsMind.dev ", DEMO_PASSWORD: "opsmind-demo" })).toEqual({
      email: "demo@opsmind.dev",
      password: "opsmind-demo",
      tenantName: "Northwind Supply (demo)",
    });
  });
});

describe("queue", () => {
  it("keeps the user name and TLS of a managed Redis URL", async () => {
    const { redisConnection } = await load<typeof import("../src/lib/queue.js")>("../src/lib/queue.js", {
      REDIS_URL: "rediss://default:p%40ss@eu1-demo.upstash.io:6380",
    });
    expect(redisConnection()).toMatchObject({
      host: "eu1-demo.upstash.io",
      port: 6380,
      username: "default",
      password: "p@ss",
      tls: {},
      maxRetriesPerRequest: null,
    });
    delete process.env.REDIS_URL;
    const local = (await load<typeof import("../src/lib/queue.js")>("../src/lib/queue.js")).redisConnection();
    expect(local).toMatchObject({ host: "localhost", port: 6379 });
    expect(local.tls).toBeUndefined();
    expect(local.username).toBeUndefined();
  });

  it("inline mode ingests in-process and reports an empty queue, without Redis", async () => {
    const ingestDocument = vi.fn(async () => "ready" as const);
    vi.doMock("../src/lib/ingest.js", async (original) => ({
      ...(await original<typeof import("../src/lib/ingest.js")>()),
      ingestDocument,
    }));
    const queue = await load<typeof import("../src/lib/queue.js")>("../src/lib/queue.js", { INGEST_MODE: "inline" });
    await queue.enqueueIngest("doc-1");
    expect(ingestDocument).toHaveBeenCalledWith("doc-1");
    expect(await queue.queueCounts()).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    expect(() => queue.redisConnection()).toThrow(/REDIS_URL is required/);
  });
});

describe("inline ingestion", () => {
  async function setup(...responses: ({ status: number; data?: object } | Error)[]) {
    const aiPost = vi.fn();
    for (const r of responses) {
      if (r instanceof Error) aiPost.mockRejectedValueOnce(r);
      else aiPost.mockResolvedValueOnce({ data: {}, ...r });
    }
    vi.doMock("../src/lib/aiClient.js", () => ({ aiPost }));
    const ingest = await load<typeof import("../src/lib/ingest.js")>("../src/lib/ingest.js");
    // The fake db of this module graph: markIngestFailed goes through its query().
    const db = (await import("../src/lib/db.js")) as unknown as typeof import("./helpers/fakeDb.js");
    const failedWith = () =>
      db.query.mock.calls.filter(([sql]) => sql.includes("SET status = 'failed'")).map(([, params]) => params);
    return { aiPost, ingest, failedWith };
  }

  it("retries transient failures with the worker's 2 s / 4 s backoff", async () => {
    vi.useFakeTimers();
    const { aiPost, ingest, failedWith } = await setup(
      { status: 503 },
      new Error("AI service unavailable"),
      { status: 200, data: { chunks: 3 } },
    );
    const outcome = ingest.ingestDocument("doc-1");
    await vi.advanceTimersByTimeAsync(1999);
    expect(aiPost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(aiPost).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await outcome).toBe("ready");
    expect(aiPost).toHaveBeenCalledTimes(3);
    expect(aiPost).toHaveBeenCalledWith("/v1/ingest", { document_id: "doc-1" }, 120_000);
    expect(failedWith()).toEqual([]);
  });

  it("gives up at once on a file the AI service cannot read, and records why", async () => {
    const { aiPost, ingest, failedWith } = await setup({ status: 422, data: { detail: "no extractable text" } });
    expect(await ingest.ingestDocument("doc-2")).toBe("failed");
    expect(aiPost).toHaveBeenCalledTimes(1);
    expect(failedWith()).toEqual([["doc-2", "no extractable text"]]);
  });

  it("marks the document failed after the third attempt, and never rejects", async () => {
    vi.useFakeTimers();
    const { aiPost, ingest, failedWith } = await setup({ status: 500 }, { status: 500 }, { status: 502 });
    const outcome = ingest.ingestDocument("doc-3");
    await vi.advanceTimersByTimeAsync(6000);
    // The fake db rejects the UPDATE like an unreachable database would; that is logged, not thrown.
    expect(await outcome).toBe("failed");
    expect(aiPost).toHaveBeenCalledTimes(3);
    expect(failedWith()).toEqual([["doc-3", "ai service responded 502"]]);
  });
});

describe("demo seed, queue mode (Compose, Helm, Codespaces)", () => {
  async function setup({
    enqueue = async (_id: string) => {},
    importDemo = async () => ({ metrics: 6, points: 1080 }),
  }: { enqueue?: (id: string) => Promise<void>; importDemo?: () => Promise<{ metrics: number; points: number }> } = {}) {
    const enqueueIngest = vi.fn(enqueue);
    const importDemoFn = vi.fn(importDemo);
    vi.doMock("../src/lib/queue.js", () => ({ enqueueIngest }));
    vi.doMock("../src/lib/metrics.js", () => ({ importDemo: importDemoFn }));
    vi.doMock("../src/lib/redis.js", () => ({ bumpDataVersion: async () => {} }));
    const { seedDemo } = await load<typeof import("../src/lib/demoSeed.js")>("../src/lib/demoSeed.js");
    const db = (await import("../src/lib/db.js")) as unknown as typeof import("./helpers/fakeDb.js");
    // The claim transaction commits three new documents.
    db.withTx.mockResolvedValueOnce({ tenantId: "t1", removedUsers: 0, added: ["d1", "d2", "d3"] } as never);
    const run = () => seedDemo({ email: "demo@x.io", password: "demo-password", tenantName: "Demo" });
    const deleted = () =>
      db.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE FROM documents")).map(([, params]) => params);
    return { run, enqueueIngest, importDemo: importDemoFn, deleted };
  }

  it("queues the new documents as soon as they are committed, before the KPI import", async () => {
    const { run, enqueueIngest, importDemo } = await setup();
    expect(await run()).toMatchObject({ documentsQueued: 3, points: 1080 });
    expect(enqueueIngest.mock.calls).toEqual([["d1"], ["d2"], ["d3"]]);
    expect(Math.max(...enqueueIngest.mock.invocationCallOrder)).toBeLessThan(importDemo.mock.invocationCallOrder[0]);
  });

  it("a failing KPI import leaves no document without a job", async () => {
    const { run, enqueueIngest } = await setup({
      importDemo: () => Promise.reject(new Error("kpi import failed")),
    });
    await expect(run()).rejects.toThrow("kpi import failed");
    expect(enqueueIngest).toHaveBeenCalledTimes(3);
  });

  it("removes the documents Redis refused, so the next run adds and queues them again", async () => {
    const { run, enqueueIngest, importDemo, deleted } = await setup({
      enqueue: async (id) => {
        if (id === "d2") throw new Error("redis down");
      },
    });
    await expect(run()).rejects.toThrow("redis down");
    expect(enqueueIngest).toHaveBeenCalledTimes(2);
    expect(deleted()).toEqual([[["d2", "d3"]]]);
    expect(importDemo).not.toHaveBeenCalled();
  });
});
