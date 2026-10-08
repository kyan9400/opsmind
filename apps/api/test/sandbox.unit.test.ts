import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));
// Every test re-imports the whole app (fresh config); a cold import can pass 5 s on a busy runner.
vi.setConfig({ testTimeout: 20_000 });

const VARS = ["ALLOW_SANDBOX", "SANDBOX_RATE_LIMIT"];

// Switches are read when the modules load, hence resetModules + dynamic imports with the variables set.
async function loadApp(env: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(process.env, env);
  const { createApp } = await import("../src/app.js");
  // The fake db instance this app was built with (a direct import of the helper may be a fresh copy).
  const db = (await import("../src/lib/db.js")) as unknown as typeof import("./helpers/fakeDb.js");
  return { app: createApp(), bearer: db.bearer };
}

afterEach(() => {
  VARS.forEach((name) => delete process.env[name]);
  vi.doUnmock("../src/lib/sandbox.js");
});

const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

describe("POST /api/v1/sandbox", () => {
  it("is closed unless ALLOW_SANDBOX=true", async () => {
    const createSandbox = vi.fn();
    vi.doMock("../src/lib/sandbox.js", () => ({ createSandbox, deleteExpiredSandboxes: vi.fn() }));
    const { app } = await loadApp();
    const res = await request(app).post("/api/v1/sandbox").expect(403);
    expect(res.body.error).toMatch(/sandbox is disabled/);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("creates sandboxes up to the per-IP budget, then answers 429", async () => {
    const createSandbox = vi.fn(async () => ({ token: "t", expiresAt: inOneDay().toISOString() }));
    vi.doMock("../src/lib/sandbox.js", () => ({ createSandbox, deleteExpiredSandboxes: vi.fn() }));
    const { app } = await loadApp({ ALLOW_SANDBOX: "true", SANDBOX_RATE_LIMIT: "2" });

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post("/api/v1/sandbox").expect(201);
      expect(res.body).toMatchObject({ token: "t" });
    }
    const blocked = await request(app).post("/api/v1/sandbox").expect(429);
    expect(blocked.body.error).toMatch(/too many temporary workspaces/);
    expect(createSandbox).toHaveBeenCalledTimes(2);
  });
});

describe("sandbox members", () => {
  it("cannot create users or change roles, while a normal owner can", async () => {
    const { app, bearer } = await loadApp();
    const sandboxOwner = bearer("owner", { sub: "sandbox-owner", tenantId: "sb1", expiresAt: inOneDay() });
    const user = { name: "Eve", email: "eve@x.io", password: "password123", role: "member" };

    const created = await request(app).post("/api/v1/users").set("authorization", sandboxOwner).send(user).expect(403);
    expect(created.body.error).toMatch(/temporary sandbox/);
    await request(app)
      .patch("/api/v1/users/00000000-0000-0000-0000-000000000000/role")
      .set("authorization", sandboxOwner)
      .send({ role: "admin" })
      .expect(403);

    // Passes RBAC and the sandbox check, then fails validation: proof the restriction is sandbox-only.
    const owner = bearer("owner", { sub: "real-owner" });
    await request(app).post("/api/v1/users").set("authorization", owner).send({}).expect(400);
  });

  it("lose access the moment the sandbox expires", async () => {
    const { app, bearer } = await loadApp();
    const live = bearer("owner", { sub: "sb-live", tenantId: "sb2", expiresAt: inOneDay() });
    // limit=0 fails validation after auth: the token was accepted.
    await request(app).get("/api/v1/audit?limit=0").set("authorization", live).expect(400);

    const expired = bearer("owner", { sub: "sb-expired", tenantId: "sb3", expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).get("/api/v1/audit?limit=0").set("authorization", expired).expect(401);
    expect(res.body.error).toBe("sandbox expired");
  });
});
