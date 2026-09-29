import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { bearer } from "./helpers/fakeDb.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

describe("metrics endpoint", () => {
  const app = createApp();

  it("exposes RED metrics labelled by route template, not raw URL", async () => {
    const token = bearer("viewer");
    await request(app).get("/health").expect(200);
    // An id in the path must collapse into the :id template (no per-id series).
    await request(app).get("/api/v1/documents/11111111-2222-3333-4444-555555555555").expect(401);
    await request(app).get("/api/v1/metrics/dashboard?days=1000").set("authorization", token).expect(400);
    await request(app).get("/no/such/route").expect(404);

    const res = await request(app).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const body = res.text;
    expect(body).toContain('http_request_duration_seconds_count{service="api",method="GET",route="/health",status_code="200"}');
    // Errors thrown inside a route keep the full template (Express resets baseUrl on error).
    expect(body).toContain('route="/api/v1/metrics/dashboard",status_code="400"');
    // Rejected by router middleware (auth) before any route matched: still attributed to its router.
    expect(body).toContain('route="/api/v1/documents/*",status_code="401"');
    expect(body).toContain('route="unmatched",status_code="404"');
    expect(body).not.toContain("11111111-2222");
    expect(body).not.toContain('route="/metrics"');
    // Default runtime metrics carry the service label too.
    expect(body).toMatch(/process_cpu_seconds_total\{service="api"\}/);
  });
});
