import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/lib/db.js";
import { closeQueue } from "../src/lib/queue.js";
import { closeRedis } from "../src/lib/redis.js";
import { deleteExpiredSandboxes } from "../src/lib/sandbox.js";

// Needs Postgres + Redis (CI provides both; queue mode hands the sample documents to a worker that is not
// running here, so they stay queued). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("sandbox workspaces (postgres)", () => {
  const app = createApp();
  const saved = { ...config };

  beforeAll(() => {
    // The sandbox routes read these per request, so the switches can be flipped without reloading the app.
    Object.assign(config, { ALLOW_SANDBOX: true, SANDBOX_RATE_LIMIT: 0 });
  });

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

  it("creates a private, seeded, owner-run workspace that expires in 24 hours", async () => {
    const before = Date.now();
    const { auth, expiresAt, me } = await createSandbox();

    const hours = (new Date(expiresAt).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
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

  it("holds at most SANDBOX_MAX_DOCUMENTS documents and SANDBOX_MAX_CSV_ROWS rows per import", async () => {
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
      Object.assign(config, { SANDBOX_MAX_ACTIVE: saved.SANDBOX_MAX_ACTIVE });
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
