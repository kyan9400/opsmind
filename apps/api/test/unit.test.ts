import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { canAssign, hasRole } from "../src/lib/rbac.js";
import { hashPassword, signToken, verifyToken } from "../src/lib/auth.js";
import { query, withTx } from "../src/lib/db.js";
import { CreateUserBody, LoginBody, RegisterBody } from "../src/schemas.js";
import { createApp } from "../src/app.js";
import { bearer, users } from "./helpers/fakeDb.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

// One app per file: createApp registers the HTTP metrics, which may only happen once per registry.
const app = createApp();

describe("rbac", () => {
  it("orders roles viewer < member < admin < owner", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(hasRole("viewer", "member")).toBe(false);
  });

  it("only allows assigning roles below your own", () => {
    expect(canAssign("owner", "admin")).toBe(true);
    expect(canAssign("admin", "member")).toBe(true);
    expect(canAssign("admin", "admin")).toBe(false);
    expect(canAssign("admin", "owner")).toBe(false);
  });
});

describe("schemas", () => {
  it("normalises email and rejects short passwords", () => {
    const ok = RegisterBody.parse({ tenantName: "Acme", name: "A", email: " A@B.COM ", password: "longenough" });
    expect(ok.email).toBe("a@b.com");
    expect(() => RegisterBody.parse({ tenantName: "Acme", name: "A", email: "a@b.com", password: "short" })).toThrow();
  });

  it("defaults new users to member", () => {
    expect(CreateUserBody.parse({ name: "B", email: "b@c.com", password: "longenough" }).role).toBe("member");
  });

  it("keeps the .invalid domain of the demo seed's owner out of new accounts", () => {
    const body = { tenantName: "Acme", name: "A", email: "Owner+1a2b3c4d@Demo.Invalid", password: "longenough" };
    expect(RegisterBody.safeParse(body).success).toBe(false);
    expect(CreateUserBody.safeParse(body).success).toBe(false);
    expect(LoginBody.safeParse(body).success).toBe(true);
  });
});

describe("tokens", () => {
  it("round-trips a principal", () => {
    const p = verifyToken(signToken({ sub: "u1", tenantId: "t1", role: "admin" }));
    expect(p).toMatchObject({ sub: "u1", tenantId: "t1", role: "admin" });
  });
});

describe("http (no database)", () => {
  it("serves /health", async () => {
    await request(app).get("/health").expect(200, { status: "ok" });
  });

  it("rejects unauthenticated requests", async () => {
    await request(app).get("/api/v1/users").expect(401);
  });

  it("rejects insufficient roles", async () => {
    await request(app).get("/api/v1/audit").set("authorization", bearer("member")).expect(403);
  });

  it("returns 400 on invalid bodies", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ email: "nope" }).expect(400);
    expect(res.body.error).toBe("validation_failed");
  });
});

describe("requireAuth uses the current role, not the one in the token", () => {
  it("trusts the database over the role claim", async () => {
    users.set("stale", { tenantId: "t1", role: "viewer" });
    const token = signToken({ sub: "stale", tenantId: "t1", role: "owner" });
    await request(app).get("/api/v1/audit").set("authorization", `Bearer ${token}`).expect(403);
  });

  it("a demoted user loses write access immediately", async () => {
    const auth = bearer("admin", { sub: "demoted" });
    // Passes RBAC and fails validation: proof the admin role was accepted.
    await request(app).post("/api/v1/users").set("authorization", auth).send({}).expect(400);
    users.set("demoted", { tenantId: "t1", role: "member" });
    await request(app).post("/api/v1/users").set("authorization", auth).send({}).expect(403);
  });

  it("a removed user gets 401 with a still-valid token", async () => {
    const auth = bearer("owner", { sub: "removed" });
    await request(app).get("/api/v1/audit?limit=0").set("authorization", auth).expect(400);
    users.delete("removed");
    const res = await request(app).get("/api/v1/audit?limit=0").set("authorization", auth).expect(401);
    expect(res.body.error).toBe("account no longer exists");
  });

  it("rejects a token whose user is not in the token's tenant", async () => {
    users.set("moved", { tenantId: "t1", role: "admin" });
    const token = signToken({ sub: "moved", tenantId: "t2", role: "admin" });
    await request(app).get("/api/v1/users").set("authorization", `Bearer ${token}`).expect(401);
  });
});

describe("account enumeration", () => {
  it("runs one bcrypt compare for unknown emails too, against a hash of the same cost", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      vi.mocked(query).mockResolvedValueOnce([]);
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@x.io", password: "password123" })
        .expect(401);
      expect(res.body).toEqual({ error: "invalid credentials" });
      expect(compare).toHaveBeenCalledTimes(1);
      const [password, hash] = compare.mock.calls[0];
      expect(password).toBe("password123");
      // "$2a$10$": same algorithm and cost factor as real password hashes, so the compare costs the same.
      expect(String(hash).slice(0, 7)).toBe((await hashPassword("x")).slice(0, 7));
    } finally {
      compare.mockRestore();
    }
  });

  it("answers a wrong password exactly like an unknown email", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      vi.mocked(query).mockResolvedValueOnce([
        { id: "u1", tenant_id: "t1", role: "member", password_hash: await hashPassword("the-real-one") },
      ]);
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "someone@x.io", password: "password123" })
        .expect(401);
      expect(res.body).toEqual({ error: "invalid credentials" });
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
    }
  });

  it("answers a taken email on register with a bare 409, without the database's details", async () => {
    vi.mocked(withTx).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        code: "23505",
        detail: "Key (email)=(taken@x.io) already exists.",
      }),
    );
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: "Acme", name: "A", email: "taken@x.io", password: "password123" })
      .expect(409);
    expect(res.body).toEqual({ error: "already exists" });
  });
});
