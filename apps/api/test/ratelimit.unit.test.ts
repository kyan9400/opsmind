import { describe, expect, it, vi } from "vitest";
import request from "supertest";

describe("credential rate limit", () => {
  it("blocks brute force on login after the per-IP budget", async () => {
    vi.resetModules();
    process.env.AUTH_RATE_LIMIT = "3";
    const { createApp } = await import("../src/app.js");
    const app = createApp();
    // Invalid bodies fail validation before touching the database, but still count as attempts.
    for (let i = 0; i < 3; i++) await request(app).post("/api/v1/auth/login").send({}).expect(400);
    const blocked = await request(app).post("/api/v1/auth/login").send({}).expect(429);
    expect(blocked.body.error).toMatch(/too many attempts/);
    // Other endpoints are not affected.
    await request(app).get("/health").expect(200);
    delete process.env.AUTH_RATE_LIMIT;
  });
});
