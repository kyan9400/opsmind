import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";

// Runs against a real Postgres (CI provides one). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("tenant isolation + RBAC (postgres)", () => {
  const app = createApp();
  const suffix = Date.now();

  afterAll(() => pool.end());

  async function register(tenant: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: tenant, name: "Owner", email: `owner-${tenant}-${suffix}@x.io`, password: "password123" })
      .expect(201);
    return res.body.token as string;
  }

  it("keeps tenants isolated and enforces role rules", async () => {
    const a = await register("acme");
    const b = await register("globex");

    await request(app)
      .post("/api/v1/users")
      .set("authorization", `Bearer ${a}`)
      .send({ name: "Mia", email: `mia-${suffix}@x.io`, password: "password123", role: "admin" })
      .expect(201);

    const listA = await request(app).get("/api/v1/users").set("authorization", `Bearer ${a}`).expect(200);
    const listB = await request(app).get("/api/v1/users").set("authorization", `Bearer ${b}`).expect(200);
    expect(listA.body.data).toHaveLength(2);
    expect(listB.body.data).toHaveLength(1);

    // The new admin cannot mint another admin.
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: `mia-${suffix}@x.io`, password: "password123" })
      .expect(200);
    await request(app)
      .post("/api/v1/users")
      .set("authorization", `Bearer ${login.body.token}`)
      .send({ name: "X", email: `x-${suffix}@x.io`, password: "password123", role: "admin" })
      .expect(403);

    const audit = await request(app).get("/api/v1/audit").set("authorization", `Bearer ${a}`).expect(200);
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain("user.created");
  });

  it("applies role changes and removals to tokens already issued", async () => {
    const owner = `Bearer ${await register("initech")}`;
    const email = `sam-${suffix}@x.io`;
    const created = await request(app)
      .post("/api/v1/users")
      .set("authorization", owner)
      .send({ name: "Sam", email, password: "password123", role: "admin" })
      .expect(201);
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: "password123" }).expect(200);
    const sam = `Bearer ${login.body.token}`;
    await request(app).get("/api/v1/audit").set("authorization", sam).expect(200);

    await request(app)
      .patch(`/api/v1/users/${created.body.id}/role`)
      .set("authorization", owner)
      .send({ role: "member" })
      .expect(200);
    await request(app).get("/api/v1/audit").set("authorization", sam).expect(403);

    await pool.query("DELETE FROM users WHERE id = $1", [created.body.id]);
    await request(app).get("/api/v1/users").set("authorization", sam).expect(401);
  });
});
