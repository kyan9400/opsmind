import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import request from "supertest";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));
// Every test re-imports the whole app (fresh config); a cold import can pass 5 s on a busy runner.
vi.setConfig({ testTimeout: 20_000 });

type FakeDb = typeof import("./helpers/fakeDb.js");

const VARS = [
  "ALLOW_SANDBOX",
  "SANDBOX_RATE_LIMIT",
  "SANDBOX_MAX_FILE_BYTES",
  "SANDBOX_WRITE_RATE_LIMIT",
  "SANDBOX_GLOBAL_WRITE_RATE_LIMIT",
  "SANDBOX_DB_BRAKE_BYTES",
  "SANDBOX_MAX_BYTES",
  "SANDBOX_MAX_ACTIVE",
];

const MB = 1024 * 1024;
const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

// Settings are read when the modules load, hence resetModules + dynamic imports with the variables set.
async function loadApp(env: Record<string, string> = {}, databaseBytes = 20 * MB) {
  vi.resetModules();
  Object.assign(process.env, env);
  const { createApp } = await import("../src/app.js");
  // The fake db instance this app was built with (a direct import of the helper may be a fresh copy).
  const db = (await import("../src/lib/db.js")) as unknown as FakeDb;
  db.answers.length = 0;
  db.answers.push({ match: /pg_database_size/, rows: () => [{ bytes: String(databaseBytes) }] });
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
  vi.doUnmock("../src/lib/queue.js");
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
  it("counts the writes that went through, per sandbox, then answers 429; refusals cost nothing", async () => {
    // Writes succeed here: every transaction query gets an answer, and nothing is indexed.
    vi.doMock("../src/lib/queue.js", () => ({ enqueueIngest: async () => {} }));
    const env = { SANDBOX_WRITE_RATE_LIMIT: "3", SANDBOX_MAX_FILE_BYTES: "1024" };
    const { app, db, sandboxOwner, owner } = await loadApp(env);
    let reindexable = false;
    const sql: string[] = [];
    const tx = {
      query: async (text: string) => {
        sql.push(text);
        return { rows: [{ n: 0, bytes: 0, id: "doc-1", title: "notes", reindexable }], rowCount: 1 };
      },
    };
    db.withTx.mockImplementation((async (fn: (client: typeof tx) => unknown) => fn(tx)) as never);
    const sandbox = sandboxOwner("sb1");
    const post = (path: string) => request(app).post(path).set("authorization", sandbox);
    const reindex = "/api/v1/documents/00000000-0000-0000-0000-000000000001/reindex";
    const uploadNotes = () => post("/api/v1/documents").attach("file", Buffer.from("notes"), "notes.txt");

    // Refused: too big, or a re-index of a document that is ready. Neither counts, and the re-index is
    // refused before the budget takes its locks.
    await post("/api/v1/documents").attach("file", Buffer.alloc(2048), "a.txt").expect(413);
    await post("/api/v1/metrics/import").attach("file", csv(2048), "k.csv").expect(413);
    const ready = await post(reindex).expect(409);
    expect(ready.body.error).toBe("a temporary workspace can only re-index a document whose indexing failed");
    expect(sql.some((q) => /FOR UPDATE|advisory/.test(q))).toBe(false);

    await uploadNotes().expect(202);
    await uploadNotes().expect(202);
    reindexable = true;
    await post(reindex).expect(202);
    const blocked = await uploadNotes().expect(429);
    expect(blocked.body.error).toMatch(/too many uploads and imports in this temporary workspace/);
    await post("/api/v1/metrics/demo").expect(429);

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

describe("sandbox write budgets (database)", () => {
  async function load(env: Record<string, string>) {
    vi.resetModules();
    Object.assign(process.env, env);
    return import("../src/lib/sandboxLimits.js");
  }

  /** A transaction that records its SQL and answers the two write counts. */
  function fakeTx(sandboxWrites: number, allSandboxWrites: number) {
    const sql: string[] = [];
    const query = vi.fn(async (text: string) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (/JOIN audit_log/.test(text)) return { rows: [{ n: allSandboxWrites }] };
      if (/FROM audit_log/.test(text)) return { rows: [{ n: sandboxWrites }] };
      return { rows: [], rowCount: 1 };
    });
    return { tx: { query } as unknown as pg.PoolClient, sql };
  }

  it("refuses uploads (503) once all sandboxes together made SANDBOX_GLOBAL_WRITE_RATE_LIMIT this hour", async () => {
    const limits = { SANDBOX_WRITE_RATE_LIMIT: "10", SANDBOX_GLOBAL_WRITE_RATE_LIMIT: "30" };
    const { reserveSandboxWrite } = await load(limits);

    const room = fakeTx(0, 29);
    await reserveSandboxWrite(room.tx, "sb1", "document.uploaded");
    // Tenant row, its own count, then the advisory lock that makes the all-sandboxes count exact.
    expect(room.sql).toEqual([
      "SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE",
      expect.stringMatching(/FROM audit_log WHERE tenant_id = \$1 /),
      "SELECT pg_advisory_xact_lock($1)",
      expect.stringMatching(/JOIN audit_log a ON a\.tenant_id = t\.id WHERE t\.expires_at IS NOT NULL /),
    ]);
    // Only the writes that index a document count there.
    const countAll = room.tx.query as unknown as ReturnType<typeof vi.fn>;
    expect(countAll.mock.calls[3][1]).toEqual([["document.uploaded", "document.reindexed"]]);

    const refused = "temporary workspaces have reached their document uploads for this hour, try again later";
    for (const action of ["document.uploaded", "document.reindexed"] as const) {
      await expect(reserveSandboxWrite(fakeTx(0, 30).tx, "sb1", action)).rejects.toMatchObject({
        status: 503,
        message: refused,
      });
    }
    // A CSV import or a demo load indexes nothing: only the sandbox's own budget applies to it.
    for (const action of ["metrics.imported", "metrics.demo_loaded"] as const) {
      const full = fakeTx(0, 30);
      await reserveSandboxWrite(full.tx, "sb1", action);
      expect(full.sql.some((q) => /advisory|JOIN audit_log/.test(q))).toBe(false);
    }
  });

  it("checks the sandbox's own budget first, and skips a budget set to 0", async () => {
    const limits = await load({ SANDBOX_WRITE_RATE_LIMIT: "2", SANDBOX_GLOBAL_WRITE_RATE_LIMIT: "30" });
    const own = fakeTx(2, 30);
    await expect(limits.reserveSandboxWrite(own.tx, "sb1", "document.uploaded")).rejects.toMatchObject({ status: 429 });
    expect(own.sql.some((q) => /advisory/.test(q))).toBe(false);

    const off = await load({ SANDBOX_WRITE_RATE_LIMIT: "0", SANDBOX_GLOBAL_WRITE_RATE_LIMIT: "0" });
    const free = fakeTx(1000, 1000);
    await off.reserveSandboxWrite(free.tx, "sb1", "document.uploaded");
    // The tenant lock stays: the document and KPI budgets that follow rely on it.
    expect(free.sql).toEqual(["SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE"]);
  });
});

describe("database brake", () => {
  it("answers 503 to sandbox writes and creation while the database is over SANDBOX_DB_BRAKE_BYTES", async () => {
    const { app, db, sandboxOwner, owner } = await loadApp(
      { SANDBOX_DB_BRAKE_BYTES: String(100 * MB), ALLOW_SANDBOX: "true", SANDBOX_RATE_LIMIT: "0" },
      101 * MB,
    );
    const sandbox = sandboxOwner();
    const purged: unknown[][] = [];
    db.answers.push({ match: /^DELETE FROM tenants/, rows: (params) => (purged.push(params), []) });

    for (const path of ["/api/v1/documents", "/api/v1/metrics/import", "/api/v1/metrics/demo"]) {
      const res = await request(app).post(path).set("authorization", sandbox).expect(503);
      expect(res.body.error).toMatch(/paused because the demo database is nearly full/);
    }
    const created = await request(app).post("/api/v1/sandbox").expect(503);
    expect(created.body.error).toMatch(/nearly full/);
    // Before refusing, the creation still deleted a batch of expired sandboxes, whose space new rows reuse.
    expect(purged).toEqual([[10]]);

    // Reads and normal workspaces are not affected (no file: 400 from the handler, after the guard).
    await request(app).get("/api/v1/audit?limit=0").set("authorization", sandbox).expect(400);
    await request(app).post("/api/v1/documents").set("authorization", owner).expect(400);
  });

  it("is disabled by SANDBOX_DB_BRAKE_BYTES=0", async () => {
    const { app, sandboxOwner } = await loadApp({ SANDBOX_DB_BRAKE_BYTES: "0" }, 10_000 * MB);
    await request(app).post("/api/v1/documents").set("authorization", sandboxOwner()).expect(400);
  });

  it("measures the database at most once a minute per instance, with one query for concurrent callers", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const limits = await import("../src/lib/sandboxLimits.js");
    const db = (await import("../src/lib/db.js")) as unknown as FakeDb;
    let bytes = 5 * MB;
    db.answers.length = 0;
    db.answers.push({ match: /pg_database_size/, rows: () => [{ bytes: String(bytes) }] });
    const measured = () => db.query.mock.calls.filter(([sql]) => /pg_database_size/.test(sql)).length;
    const before = measured();

    expect(await Promise.all([limits.databaseBytes(), limits.databaseBytes()])).toEqual([5 * MB, 5 * MB]);
    expect(measured() - before).toBe(1);
    bytes = 6 * MB;
    await vi.advanceTimersByTimeAsync(limits.DB_SIZE_TTL_MS - 1);
    expect(await limits.databaseBytes()).toBe(5 * MB);
    await vi.advanceTimersByTimeAsync(1);
    expect(await limits.databaseBytes()).toBe(6 * MB);
    expect(measured() - before).toBe(2);
  });
});

describe("sandbox creation", () => {
  it("still applies the brake when the cleanup of expired sandboxes fails", async () => {
    const { app } = await loadApp(
      { SANDBOX_DB_BRAKE_BYTES: String(MB), ALLOW_SANDBOX: "true", SANDBOX_RATE_LIMIT: "0" },
      2 * MB,
    );
    // No answer for the DELETE: it fails like an unreachable database, is logged, and creation goes on.
    const res = await request(app).post("/api/v1/sandbox").expect(503);
    expect(res.body.error).toMatch(/nearly full/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("expired sandbox cleanup failed"));
  });
});

describe("sandbox settings", () => {
  it("default to small budgets, and read a blank value as unset", async () => {
    vi.resetModules();
    process.env.SANDBOX_MAX_BYTES = " ";
    const { config } = await import("../src/config.js");
    expect(config).toMatchObject({
      SANDBOX_TTL_HOURS: 3,
      SANDBOX_MAX_ACTIVE: 20,
      SANDBOX_MAX_DOCUMENTS: 10,
      SANDBOX_MAX_BYTES: MB,
      SANDBOX_MAX_FILE_BYTES: 512 * 1024,
      SANDBOX_MAX_CSV_ROWS: 5000,
      SANDBOX_WRITE_RATE_LIMIT: 10,
      SANDBOX_GLOBAL_WRITE_RATE_LIMIT: 30,
      SANDBOX_DB_BRAKE_BYTES: 350 * MB,
    });
  });
});
