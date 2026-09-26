import { describe, expect, it } from "vitest";
import request from "supertest";
import { canAssign, hasRole } from "../src/lib/rbac.js";
import { signToken, verifyToken } from "../src/lib/auth.js";
import { CreateUserBody, RegisterBody } from "../src/schemas.js";
import { createApp } from "../src/app.js";

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
});

describe("tokens", () => {
  it("round-trips a principal", () => {
    const p = verifyToken(signToken({ sub: "u1", tenantId: "t1", role: "admin" }));
    expect(p).toMatchObject({ sub: "u1", tenantId: "t1", role: "admin" });
  });
});

describe("http (no database)", () => {
  const app = createApp();

  it("serves /health", async () => {
    await request(app).get("/health").expect(200, { status: "ok" });
  });

  it("rejects unauthenticated requests", async () => {
    await request(app).get("/api/v1/users").expect(401);
  });

  it("rejects insufficient roles before touching the database", async () => {
    const token = signToken({ sub: "u1", tenantId: "t1", role: "member" });
    await request(app).get("/api/v1/audit").set("authorization", `Bearer ${token}`).expect(403);
  });

  it("returns 400 on invalid bodies", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ email: "nope" }).expect(400);
    expect(res.body.error).toBe("validation_failed");
  });
});
