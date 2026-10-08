import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));
// Every test re-imports the whole app (fresh config); a cold import can pass 5 s on a busy runner.
vi.setConfig({ testTimeout: 20_000 });

type FakeDb = typeof import("./helpers/fakeDb.js");

const VARS = [
  "SANDBOX_MAX_FILE_BYTES",
  "SANDBOX_WRITE_RATE_LIMIT",
  "SANDBOX_MAX_BYTES",
  "SANDBOX_MAX_ACTIVE",
];

const MB = 1024 * 1024;
const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

// Settings are read when the modules load, hence resetModules + dynamic imports with the variables set.
async function loadApp(env: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(process.env, env);
  const { createApp } = await import("../src/app.js");
  // The fake db instance this app was built with (a direct import of the helper may be a fresh copy).
  const db = (await import("../src/lib/db.js")) as unknown as FakeDb;
  db.answers.length = 0;
  const sandboxOwner = (tenantId = "sb1") =>
    db.bearer("owner", { sub: `owner-${tenantId}`, tenantId, expiresAt: inOneDay() });
  return { app: createApp(), db, sandboxOwner, owner: db.bearer("owner", { sub: "real-owner" }) };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  VARS.forEach((name) => delete process.env[name]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A KPI CSV of about `bytes` bytes. */
const csv = (bytes: number) =>
  Buffer.from(`date,metric,value\n${"2026-01-01,Orders,1\n".repeat(Math.ceil(bytes / 20))}`);

describe("sandbox file size", () => {
  it("refuses a sandbox file over SANDBOX_MAX_FILE_BYTES; other workspaces keep MAX_UPLOAD_BYTES", async () => {
    const { app, sandboxOwner, owner } = await loadApp({ SANDBOX_MAX_FILE_BYTES: "1024" });
    const sandbox = sandboxOwner();

    const doc = await request(app)
      .post("/api/v1/documents")
      .set("authorization", sandbox)
      .attach("file", Buffer.alloc(2048, "a"), "big.txt")
      .expect(413);
    expect(doc.body.error).toBe("a temporary workspace accepts files up to 1 KB");
    const kpis = await request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", sandbox)
      .attach("file", csv(2048), "kpis.csv")
      .expect(413);
    expect(kpis.body.error).toBe("a temporary workspace accepts files up to 1 KB");

    // A normal workspace gets past the upload (and only then fails: there is no database here).
    const normal = await request(app)
      .post("/api/v1/documents")
      .set("authorization", owner)
      .attach("file", Buffer.alloc(2048, "a"), "big.txt");
    expect(normal.status).toBe(500);
  });

  it("formats limits for people", async () => {
    const { formatBytes } = await import("../src/lib/files.js");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(2 * MB)).toBe("2 MB");
    expect(formatBytes(1.5 * MB)).toBe("1.5 MB");
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(MB - 100)).toBe("1 MB");
  });
});

describe("sandbox write budget (in memory)", () => {
  it("counts uploads, imports, re-indexes and demo loads per sandbox, then answers 429", async () => {
    const env = { SANDBOX_WRITE_RATE_LIMIT: "3", SANDBOX_MAX_FILE_BYTES: "1024" };
    const { app, sandboxOwner, owner } = await loadApp(env);
    const sandbox = sandboxOwner("sb1");
    const post = (path: string) => request(app).post(path).set("authorization", sandbox);
    const reindex = "/api/v1/documents/00000000-0000-0000-0000-000000000001/reindex";

    // Refused or failed requests count too: the budget is about load, not about successful writes.
    await post("/api/v1/documents").attach("file", Buffer.alloc(2048), "a.txt").expect(413);
    await post("/api/v1/metrics/import").attach("file", csv(2048), "k.csv").expect(413);
    await post(reindex).expect(500); // past the guard; there is no database here
    const blocked = await post("/api/v1/metrics/demo").expect(429);
    expect(blocked.body.error).toMatch(/too many uploads and imports in this temporary workspace/);
    await post(reindex).expect(429);

    // Reading is not limited, another sandbox has a budget of its own, and normal workspaces have none.
    await request(app).get("/api/v1/audit?limit=0").set("authorization", sandbox).expect(400);
    await request(app).post("/api/v1/documents").set("authorization", sandboxOwner("sb2")).expect(400);
    for (let i = 0; i < 5; i++) await request(app).post("/api/v1/documents").set("authorization", owner).expect(400);
  });

  it("is disabled by SANDBOX_WRITE_RATE_LIMIT=0", async () => {
    const { app, sandboxOwner } = await loadApp({ SANDBOX_WRITE_RATE_LIMIT: "0" });
    const sandbox = sandboxOwner();
    for (let i = 0; i < 25; i++) await request(app).post("/api/v1/documents").set("authorization", sandbox).expect(400);
  });
});

describe("sandbox settings", () => {
  it("default to small budgets, and read a blank value as unset", async () => {
    vi.resetModules();
    process.env.SANDBOX_MAX_BYTES = " ";
    const { config } = await import("../src/config.js");
    expect(config).toMatchObject({
      SANDBOX_MAX_ACTIVE: 20,
      SANDBOX_MAX_DOCUMENTS: 10,
      SANDBOX_MAX_BYTES: MB,
      SANDBOX_MAX_FILE_BYTES: 512 * 1024,
      SANDBOX_MAX_CSV_ROWS: 5000,
      SANDBOX_WRITE_RATE_LIMIT: 20,
    });
  });
});
