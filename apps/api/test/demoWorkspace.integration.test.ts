import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool, withTx } from "../src/lib/db.js";
import { claimDemoWorkspace, demoOwnerEmail } from "../src/lib/demoWorkspace.js";

// Runs against a real Postgres (CI provides one). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("demo workspace seed (postgres)", () => {
  const app = createApp();
  const suffix = Date.now();
  const tenantName = `Demo ${suffix}`;

  afterAll(() => pool.end());

  const claim = (email: string, viewerHash = "viewer-hash", name = tenantName) =>
    withTx((tx) => claimDemoWorkspace(tx, { email, tenantName: name, viewerHash, ownerHash: "owner-hash" }));
  const accounts = async (tenantId: string) =>
    (
      await pool.query<{ email: string; role: string; password_hash: string }>(
        "SELECT email, role, password_hash FROM users WHERE tenant_id = $1 ORDER BY email",
        [tenantId],
      )
    ).rows;

  it("creates the workspace once, then resets both accounts and removes everyone else", async () => {
    const email = `demo-${suffix}@x.io`;
    const first = await claim(email, "viewer-1");
    expect(first.removedUsers).toBe(0);

    // Somebody got more than a look: an extra admin, a promoted visitor login, a demoted owner.
    await pool.query(
      "INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, 'Intruder', 'x', 'admin')",
      [first.tenantId, `intruder-${suffix}@x.io`],
    );
    await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
    await pool.query("UPDATE users SET role = 'member' WHERE email = $1", [demoOwnerEmail(first.tenantId)]);

    expect(await claim(email, "viewer-2")).toEqual({ tenantId: first.tenantId, removedUsers: 1 });
    expect(await accounts(first.tenantId)).toEqual([
      { email, role: "viewer", password_hash: "viewer-2" },
      { email: demoOwnerEmail(first.tenantId), role: "owner", password_hash: "owner-hash" },
    ]);

    // After a DEMO_TENANT_NAME change it can no longer tell its workspace apart, so it stops.
    await expect(claim(email, "viewer-3", "Renamed demo")).rejects.toThrow(/did not create/);
  });

  it("refuses an email that belongs to someone else's workspace, even one dressed up as the demo", async () => {
    // Registered before the operator first seeds, under the demo's name.
    const email = `taken-${suffix}@x.io`;
    const reg = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName, name: "Real owner", email, password: "password123" })
      .expect(201);
    const auth = `Bearer ${reg.body.token}`;
    const { body: me } = await request(app).get("/api/v1/auth/me").set("authorization", auth).expect(200);

    // The API refuses the seed owner's address; a row planted behind its back lacks the seed's timestamp.
    await request(app)
      .post("/api/v1/users")
      .set("authorization", auth)
      .send({ name: "Look-alike", email: demoOwnerEmail(me.tenantId), password: "password123", role: "admin" })
      .expect(400);
    await pool.query(
      "INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, 'Look-alike', 'x', 'owner')",
      [me.tenantId, demoOwnerEmail(me.tenantId)],
    );

    await expect(claim(email)).rejects.toThrow(/did not create/);
    // Rolled back: nobody was removed, and the account keeps its role and password.
    expect((await accounts(me.tenantId)).map((u) => u.role)).toEqual(["owner", "owner"]);
    await request(app).post("/api/v1/auth/login").send({ email, password: "password123" }).expect(200);
  });
});
