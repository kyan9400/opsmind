import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";
import { closeQueue, queueCounts } from "../src/lib/queue.js";

// Needs Postgres + Redis (CI provides both). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("documents (postgres + redis)", () => {
  const app = createApp();
  const suffix = Date.now();

  afterAll(async () => {
    await closeQueue();
    await pool.end();
  });

  async function register(tenant: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: tenant, name: "Owner", email: `docs-${tenant}-${suffix}@x.io`, password: "password123" })
      .expect(201);
    return `Bearer ${res.body.token}`;
  }

  it("accepts an upload, queues ingestion and keeps documents tenant-scoped", async () => {
    const a = await register("acme");
    const b = await register("globex");
    const before = await queueCounts();

    const upload = await request(app)
      .post("/api/v1/documents")
      .set("authorization", a)
      .attach("file", Buffer.from("Refunds are accepted within 30 days."), "refund_policy.txt")
      .expect(202);
    expect(upload.body).toMatchObject({ title: "refund policy", status: "queued", mimeType: "text/plain" });
    expect(upload.body).not.toHaveProperty("content");

    const after = await queueCounts();
    expect(after.waiting + after.active).toBeGreaterThan(before.waiting + before.active);

    const listA = await request(app).get("/api/v1/documents").set("authorization", a).expect(200);
    const listB = await request(app).get("/api/v1/documents").set("authorization", b).expect(200);
    expect(listA.body.data.map((d: { id: string }) => d.id)).toContain(upload.body.id);
    expect(listB.body.data).toHaveLength(0);

    await request(app).get(`/api/v1/documents/${upload.body.id}`).set("authorization", b).expect(404);
    await request(app).delete(`/api/v1/documents/${upload.body.id}`).set("authorization", b).expect(404);
    await request(app).get("/api/v1/documents/not-a-uuid").set("authorization", a).expect(404);

    await request(app).delete(`/api/v1/documents/${upload.body.id}`).set("authorization", a).expect(204);
  });
});
