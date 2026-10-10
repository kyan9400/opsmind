import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/lib/db.js";
import { closeQueue } from "../src/lib/queue.js";
import { closeRedis } from "../src/lib/redis.js";
import { deleteExpiredSandboxes } from "../src/lib/sandbox.js";
import { SANDBOX_INDEXING_ACTIONS, SANDBOX_WRITE_ACTIONS } from "../src/lib/sandboxLimits.js";

// Needs Postgres + Redis (CI provides both; queue mode hands the sample documents to a worker that is not
// running here, so they stay queued). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("sandbox workspaces (postgres)", () => {
  const app = createApp();
  const saved = { ...config };
  // This file creates more sandboxes than the default SANDBOX_MAX_ACTIVE, and makes more sandbox writes than
  // the default SANDBOX_GLOBAL_WRITE_RATE_LIMIT (one test turns that on).
  const MAX_ACTIVE = 1000;

  beforeAll(() => {
    // The sandbox routes read these per request, so the switches can be flipped without reloading the app.
    Object.assign(config, {
      ALLOW_SANDBOX: true,
      SANDBOX_RATE_LIMIT: 0,
      SANDBOX_MAX_ACTIVE: MAX_ACTIVE,
      SANDBOX_GLOBAL_WRITE_RATE_LIMIT: 0,
    });
  });

  /** Runs `fn` with some settings changed, and puts them back even when it fails. */
  async function withSettings(settings: Partial<typeof config>, fn: () => Promise<void>) {
    const before = Object.fromEntries(Object.keys(settings).map((k) => [k, config[k as keyof typeof config]]));
    Object.assign(config, settings);
    try {
      await fn();
    } finally {
      Object.assign(config, before);
    }
  }

  afterAll(async () => {
    Object.assign(config, saved);
    await closeQueue();
    await closeRedis();
    await pool.end();
  });

  async function createSandbox() {
    const res = await request(app).post("/api/v1/sandbox").expect(201);
    const auth = `Bearer ${res.body.token as string}`;
    const me = await request(app).get("/api/v1/auth/me").set("authorization", auth).expect(200);
    return { auth, expiresAt: res.body.expiresAt as string, me: me.body };
  }

  it("creates a private, seeded, owner-run workspace that expires after SANDBOX_TTL_HOURS, its token too", async () => {
    const before = Date.now();
    const { auth, expiresAt, me } = await createSandbox();

    const hours = (new Date(expiresAt).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(config.SANDBOX_TTL_HOURS - 0.1);
    expect(hours).toBeLessThan(config.SANDBOX_TTL_HOURS + 0.1);
    const token = jwt.decode(auth.slice("Bearer ".length)) as { iat: number; exp: number };
    expect(token.exp - token.iat).toBe(config.SANDBOX_TTL_HOURS * 3600);
    expect(me).toMatchObject({ role: "owner", tenantName: "Sandbox workspace" });
    expect(new Date(me.expiresAt).toISOString()).toBe(expiresAt);
    expect(me.email).toMatch(/^sandbox\+[0-9a-f]{32}@sandbox\.invalid$/);

    const docs = await request(app).get("/api/v1/documents").set("authorization", auth).expect(200);
    expect(docs.body.data.map((d: { title: string }) => d.title).sort()).toEqual([
      "Expense approval",
      "Refund and returns policy",
      "Shipping and delivery",
      "Support incident runbook",
    ]);
    const dashboard = await request(app).get("/api/v1/metrics/dashboard?days=30").set("authorization", auth).expect(200);
    expect(dashboard.body.kpis).toHaveLength(6);

    // Each visitor gets a workspace of their own.
    const other = await createSandbox();
    expect(other.me.tenantId).not.toBe(me.tenantId);
  });

  it("cannot invite people or change roles", async () => {
    const { auth, me } = await createSandbox();
    await request(app)
      .post("/api/v1/users")
      .set("authorization", auth)
      .send({ name: "Eve", email: `eve-${Date.now()}@x.io`, password: "password123", role: "admin" })
      .expect(403);
    await request(app)
      .patch(`/api/v1/users/${me.id}/role`)
      .set("authorization", auth)
      .send({ role: "viewer" })
      .expect(403);
  });

  it("holds at most SANDBOX_MAX_DOCUMENTS documents and refuses a CSV longer than SANDBOX_MAX_CSV_ROWS", async () => {
    const { auth, me } = await createSandbox();
    // Fill up to the cap directly; the 4 samples count.
    await pool.query(
      `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content, status)
       SELECT $1, 'filler ' || g, 'filler.txt', 'text/plain', 1, 'x', 'ready' FROM generate_series(1, $2) g`,
      [me.tenantId, config.SANDBOX_MAX_DOCUMENTS - 4],
    );
    const res = await request(app)
      .post("/api/v1/documents")
      .set("authorization", auth)
      .attach("file", Buffer.from("one too many"), "extra.txt")
      .expect(403);
    expect(res.body.error).toMatch(/at most 10 documents/);

    const csv = ["date,metric,value", ...Array.from({ length: 6 }, (_, i) => `2026-01-0${i + 1},Orders,${i}`)].join("\n");
    Object.assign(config, { SANDBOX_MAX_CSV_ROWS: 5 });
    try {
      await request(app)
        .post("/api/v1/metrics/import")
        .set("authorization", auth)
        .attach("file", Buffer.from(csv), "kpis.csv")
        .expect(413);
    } finally {
      Object.assign(config, { SANDBOX_MAX_CSV_ROWS: saved.SANDBOX_MAX_CSV_ROWS });
    }
  });

  it("refuses new sandboxes once SANDBOX_MAX_ACTIVE are live", async () => {
    await createSandbox();
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants WHERE expires_at > now()");
    Object.assign(config, { SANDBOX_MAX_ACTIVE: rows[0].n });
    try {
      await request(app).post("/api/v1/sandbox").expect(503);
    } finally {
      Object.assign(config, { SANDBOX_MAX_ACTIVE: MAX_ACTIVE });
    }
  });

  it("rejects the token once expired, and the cleanup deletes the sandbox but no permanent workspace", async () => {
    const { auth, me } = await createSandbox();
    const owner = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: "Permanent", name: "P", email: `perm-${Date.now()}@x.io`, password: "password123" })
      .expect(201);

    await pool.query("UPDATE tenants SET expires_at = now() - interval '1 minute' WHERE id = $1", [me.tenantId]);
    const res = await request(app).get("/api/v1/documents").set("authorization", auth).expect(401);
    expect(res.body.error).toBe("sandbox expired");

    expect(await deleteExpiredSandboxes()).toBeGreaterThanOrEqual(1);
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM tenants WHERE id = $1)::int AS tenants,
              (SELECT count(*) FROM documents WHERE tenant_id = $1)::int AS documents,
              (SELECT count(*) FROM metric_points WHERE tenant_id = $1)::int AS points,
              (SELECT count(*) FROM users WHERE tenant_id = $1)::int AS users`,
      [me.tenantId],
    );
    expect(left.rows[0]).toEqual({ tenants: 0, documents: 0, points: 0, users: 0 });
    await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${owner.body.token}`).expect(200);
  });

  const upload = (auth: string, body: string, name = "notes.txt") =>
    request(app).post("/api/v1/documents").set("authorization", auth).attach("file", Buffer.from(body), name);
  const importCsv = (auth: string, lines: string[]) =>
    request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", auth)
      .attach("file", Buffer.from(["date,metric,value", ...lines].join("\n")), "kpis.csv");
  const statuses = (responses: { status: number }[]) => responses.map((r) => r.status).sort();
  const one = async (sql: string, params: unknown[]) => (await pool.query<{ n: number }>(sql, params)).rows[0].n;
  const documentBytes = (tenantId: string) =>
    one("SELECT coalesce(sum(size_bytes), 0)::int AS n FROM documents WHERE tenant_id = $1", [tenantId]);

  it("keeps each sandbox within SANDBOX_MAX_FILE_BYTES per file and SANDBOX_MAX_BYTES in total", async () => {
    const { auth, me } = await createSandbox();
    const big = await upload(auth, "a".repeat(config.SANDBOX_MAX_FILE_BYTES + 1)).expect(413);
    expect(big.body.error).toBe("a temporary workspace accepts files up to 512 KB");

    // Fill the budget up to the last 100 bytes.
    await pool.query(
      `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content, status)
       VALUES ($1, 'filler', 'filler.txt', 'text/plain', $2, 'x', 'ready')`,
      [me.tenantId, config.SANDBOX_MAX_BYTES - (await documentBytes(me.tenantId)) - 100],
    );
    const full = await upload(auth, "b".repeat(101)).expect(413);
    expect(full.body.error).toBe(
      "a temporary workspace holds at most 1 MB of documents (1 MB used), delete one to make room",
    );
    await upload(auth, "c".repeat(100)).expect(202);
  });

  it("checks parallel uploads to one sandbox one after another, so its caps hold", async () => {
    const { auth, me } = await createSandbox();
    const documents = () => one("SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1", [me.tenantId]);

    // Room for 2 more documents next to the 4 samples; 5 arrive at once.
    await withSettings({ SANDBOX_MAX_DOCUMENTS: 6 }, async () => {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => upload(auth, `parallel ${i}`)));
      expect(statuses(results)).toEqual([202, 202, 403, 403, 403]);
    });
    expect(await documents()).toBe(6);

    // The byte budget too: room for two 100-byte files, four arrive at once.
    await withSettings({ SANDBOX_MAX_BYTES: (await documentBytes(me.tenantId)) + 250 }, async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => upload(auth, "d".repeat(100))));
      expect(statuses(results)).toEqual([202, 202, 413, 413]);
    });
    expect(await documents()).toBe(8);
  });

  it("caps the KPI data points a sandbox holds across all of its imports", async () => {
    const { auth, me } = await createSandbox();
    const points = () => one("SELECT count(*)::int AS n FROM metric_points WHERE tenant_id = $1", [me.tenantId]);
    const rows = (metric: string, n: number) =>
      Array.from({ length: n }, (_, i) => `2020-01-${String(i + 1).padStart(2, "0")},${metric},${i}`);
    const held = await points(); // the sample KPIs

    await withSettings({ SANDBOX_MAX_CSV_ROWS: held + 3 }, async () => {
      await importCsv(auth, rows("Visitors", 3)).expect(201);
      const over = await importCsv(auth, rows("Signups", 1)).expect(413);
      expect(over.body.error).toBe(
        `a temporary workspace holds at most ${held + 3} KPI data points (it has ${held + 3}, this import would add 1)`,
      );
      // Points it already holds are overwritten in place, so importing them again still fits.
      await importCsv(auth, rows("Visitors", 3)).expect(201);
    });
    expect(await points()).toBe(held + 3);

    // Two imports at once with room for one: the second waits for the first, then no longer fits.
    await withSettings({ SANDBOX_MAX_CSV_ROWS: held + 6 }, async () => {
      const results = await Promise.all([importCsv(auth, rows("Refunds", 3)), importCsv(auth, rows("Returns", 3))]);
      expect(statuses(results)).toEqual([201, 413]);
    });
    expect(await points()).toBe(held + 6);
  });

  const demoLoad = (auth: string) => request(app).post("/api/v1/metrics/demo").set("authorization", auth);

  it("counts every kind of sandbox write of the last hour in the database, so the budget holds across instances", async () => {
    const { auth, me } = await createSandbox();
    // Five writes another instance served (one of each kind, and a second upload): this instance's
    // in-memory counter never saw them.
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, created_at)
       SELECT $1, $2, action, now() - interval '5 minutes' FROM unnest($3::text[]) AS action`,
      [me.tenantId, me.id, [...SANDBOX_WRITE_ACTIONS, "document.uploaded"]],
    );
    const {
      rows: [failed],
    } = await pool.query<{ id: string }>(
      `UPDATE documents SET status = 'failed', error = 'boom'
        WHERE id = (SELECT id FROM documents WHERE tenant_id = $1 ORDER BY title LIMIT 1) RETURNING id`,
      [me.tenantId],
    );
    await withSettings({ SANDBOX_WRITE_RATE_LIMIT: 5 }, async () => {
      // In memory each of these is only the 1st to 4th of 5; the count in the database refuses them.
      const attempts = [
        () => upload(auth, "one more"),
        () => importCsv(auth, ["2020-01-01,Visitors,1"]),
        () => request(app).post(`/api/v1/documents/${failed.id}/reindex`).set("authorization", auth),
        () => demoLoad(auth),
      ];
      for (const attempt of attempts) {
        const res = await attempt();
        expect([res.status, res.body.error]).toEqual([
          429,
          "a temporary workspace allows 5 uploads and imports per hour, try again later",
        ]);
      }
      // An hour later they no longer count.
      await pool.query("UPDATE audit_log SET created_at = now() - interval '61 minutes' WHERE tenant_id = $1", [
        me.tenantId,
      ]);
      await upload(auth, "one more").expect(202);
    });
  });

  it("caps the uploads of all sandboxes together per hour, also when they arrive at once", async () => {
    const sandboxes = await Promise.all(Array.from({ length: 4 }, () => createSandbox()));
    const allWrites = () =>
      one(
        `SELECT count(*)::int AS n FROM tenants t JOIN audit_log a ON a.tenant_id = t.id
          WHERE t.expires_at IS NOT NULL AND a.action = ANY($1::text[]) AND a.created_at > now() - interval '1 hour'`,
        [SANDBOX_INDEXING_ACTIONS],
      );
    const refused = "temporary workspaces have reached their document uploads for this hour, try again later";

    // Room for two more uploads: two sandboxes use them, a third is refused although it made none.
    await withSettings({ SANDBOX_GLOBAL_WRITE_RATE_LIMIT: (await allWrites()) + 2 }, async () => {
      await upload(sandboxes[0].auth, "first").expect(202);
      await upload(sandboxes[1].auth, "second").expect(202);
      const res = await upload(sandboxes[2].auth, "third").expect(503);
      expect(res.body.error).toBe(refused);
      // KPI writes index nothing, so they neither count nor wait for room.
      await importCsv(sandboxes[3].auth, ["2020-01-01,Visitors,1"]).expect(201);
      await demoLoad(sandboxes[3].auth).expect(201);
      expect((await upload(sandboxes[3].auth, "fourth").expect(503)).body.error).toBe(refused);
    });

    // Four sandboxes at once with room for two: the advisory lock makes them take turns.
    await withSettings({ SANDBOX_GLOBAL_WRITE_RATE_LIMIT: (await allWrites()) + 2 }, async () => {
      const results = await Promise.all(sandboxes.map((s, i) => upload(s.auth, `parallel ${i}`)));
      expect(statuses(results)).toEqual([202, 202, 503, 503]);
    });
  });

  it("loads the demo KPIs into a sandbox only within its point budget", async () => {
    const { auth, me } = await createSandbox();
    const points = () => one("SELECT count(*)::int AS n FROM metric_points WHERE tenant_id = $1", [me.tenantId]);
    // The samples are this same demo data, so reloading it adds no point and fits even a full budget.
    const held = await points();
    await withSettings({ SANDBOX_MAX_CSV_ROWS: held }, async () => {
      const res = await demoLoad(auth).expect(201);
      expect(res.body.imported).toEqual({ metrics: 6, points: held });
    });

    // Without one metric's points, a reload adds exactly those back (demo points are matched by metric key).
    const deleted = await pool.query(
      "DELETE FROM metric_points WHERE metric_id = (SELECT id FROM metrics WHERE tenant_id = $1 ORDER BY key LIMIT 1)",
      [me.tenantId],
    );
    const removed = deleted.rowCount ?? 0;
    expect(removed).toBeGreaterThan(0);
    await withSettings({ SANDBOX_MAX_CSV_ROWS: held - 1 }, async () => {
      const over = await demoLoad(auth).expect(413);
      expect(over.body.error).toBe(
        `a temporary workspace holds at most ${held - 1} KPI data points ` +
          `(it has ${held - removed}, this import would add ${removed})`,
      );
    });
    expect(await points()).toBe(held - removed);
    await withSettings({ SANDBOX_MAX_CSV_ROWS: held }, async () => {
      await demoLoad(auth).expect(201);
    });
    expect(await points()).toBe(held);
  });

  it("re-indexes only failed or stuck documents in a sandbox; a normal workspace may re-index any", async () => {
    const { auth, me } = await createSandbox();
    const { rows: docs } = await pool.query<{ id: string }>(
      "SELECT id FROM documents WHERE tenant_id = $1 ORDER BY title",
      [me.tenantId],
    );
    const reindex = (id: string, as = auth) =>
      request(app).post(`/api/v1/documents/${id}/reindex`).set("authorization", as);

    // Queued a moment ago (no worker runs here): its indexing may still be on the way.
    const queued = await reindex(docs[0].id).expect(409);
    expect(queued.body.error).toBe("a temporary workspace can only re-index a document whose indexing failed");
    await pool.query("UPDATE documents SET status = 'ready' WHERE id = $1", [docs[1].id]);
    await reindex(docs[1].id).expect(409);
    await pool.query("UPDATE documents SET status = 'failed', error = 'boom' WHERE id = $1", [docs[2].id]);
    await reindex(docs[2].id).expect(202, { id: docs[2].id, status: "queued" });
    // Stuck: processing for longer than any indexing run takes.
    await pool.query(
      "UPDATE documents SET status = 'processing', updated_at = now() - interval '20 minutes' WHERE id = $1",
      [docs[3].id],
    );
    await reindex(docs[3].id).expect(202);
    await reindex("00000000-0000-0000-0000-000000000000").expect(404);

    const owner = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: "Reindex", name: "R", email: `reindex-${Date.now()}@x.io`, password: "password123" })
      .expect(201);
    const normal = `Bearer ${owner.body.token as string}`;
    const doc = await upload(normal, "Refunds take 30 days.").expect(202);
    await reindex(doc.body.id, normal).expect(202);
    await reindex(doc.body.id, normal).expect(202);
  });

  it("pauses sandbox creation and sandbox writes while the database is over SANDBOX_DB_BRAKE_BYTES", async () => {
    const { auth } = await createSandbox();
    await withSettings({ SANDBOX_DB_BRAKE_BYTES: 1 }, async () => {
      const created = await request(app).post("/api/v1/sandbox").expect(503);
      expect(created.body.error).toMatch(/demo database is nearly full/);
      await upload(auth, "x").expect(503);
      await importCsv(auth, ["2020-01-01,Visitors,1"]).expect(503);
      await request(app).post("/api/v1/metrics/demo").set("authorization", auth).expect(503);
      // Reading goes on as usual.
      await request(app).get("/api/v1/documents").set("authorization", auth).expect(200);
    });
    await upload(auth, "x").expect(202);
  });

  it("deletes expired sandboxes when a new one is created, a bounded batch at a time", async () => {
    const ids = (await Promise.all([createSandbox(), createSandbox(), createSandbox()])).map((s) => s.me.tenantId);
    // Expired long ago, so these are the oldest expired sandboxes and go first.
    await pool.query(
      `UPDATE tenants SET expires_at = '2000-01-01'::timestamptz + array_position($1::uuid[], id) * interval '1 day'
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const left = async () =>
      (await pool.query<{ id: string }>("SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY expires_at", [ids]))
        .rows.map((r) => r.id);

    expect(await deleteExpiredSandboxes(1)).toBe(1);
    expect(await left()).toEqual([ids[1], ids[2]]);
    // The next visitor's sandbox takes the rest with it, without waiting for the daily cron.
    await createSandbox();
    expect(await left()).toEqual([]);
  });
});
