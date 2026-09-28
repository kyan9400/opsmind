import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";
import { closeRedis } from "../src/lib/redis.js";
import { eachDay } from "../src/lib/dates.js";

// Needs Postgres + Redis (CI provides both). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("metrics (postgres + redis)", () => {
  const app = createApp();
  const suffix = Date.now();
  const TO = "2026-09-26";

  afterAll(async () => {
    await closeRedis();
    await pool.end();
  });

  async function register(tenant: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ tenantName: tenant, name: "Owner", email: `kpi-${tenant}-${suffix}@x.io`, password: "password123" })
      .expect(201);
    return `Bearer ${res.body.token}`;
  }

  // 14 days: previous week revenue 100/day, current week 150/day; resolution time 4h then 5h.
  const days = eachDay("2026-09-13", TO);
  const csv = [
    "date,metric,value",
    ...days.map((d, i) => `${d},Revenue,${i < 7 ? 100 : 150}`),
    ...days.map((d, i) => `${d},Resolution time,${i < 7 ? 4 : 5}`),
    "2026-09-26,Revenue,160", // duplicate day: last row wins
    "not-a-date,Revenue,1",
  ].join("\n");

  it("imports CSV, aggregates periods and buckets, and stays tenant-scoped", async () => {
    const a = await register("acme");
    const b = await register("globex");

    const imp = await request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", a)
      .attach("file", Buffer.from(csv), "kpis.csv")
      .expect(201);
    expect(imp.body.imported).toEqual({ metrics: 2, points: 28 });
    expect(imp.body.errorCount).toBe(1);

    const dash = await request(app)
      .get(`/api/v1/metrics/dashboard?days=7&to=${TO}`)
      .set("authorization", a)
      .expect(200);
    const revenue = dash.body.kpis.find((k: { key: string }) => k.key === "revenue");
    expect(revenue.current).toBe(150 * 6 + 160);
    expect(revenue.previous).toBe(700);
    expect(revenue.deltaPct).toBeCloseTo(((1060 - 700) / 700) * 100);
    expect(revenue.series).toHaveLength(7);

    // Switch resolution time to an average metric where lower is better.
    const rt = dash.body.kpis.find((k: { key: string }) => k.key === "resolution-time");
    await request(app)
      .patch(`/api/v1/metrics/${rt.id}`)
      .set("authorization", a)
      .send({ aggregation: "avg", direction: "down", unit: "h" })
      .expect(200);
    const dash2 = await request(app)
      .get(`/api/v1/metrics/dashboard?days=7&to=${TO}&bucket=week`)
      .set("authorization", a)
      .expect(200);
    const rt2 = dash2.body.kpis.find((k: { key: string }) => k.key === "resolution-time");
    expect(rt2).toMatchObject({ aggregation: "avg", direction: "down", unit: "h", current: 5, previous: 4 });
    // 2026-09-20..26 spans two ISO weeks (Mon 14th and Mon 21st), both partial.
    expect(rt2.series.map((s: { bucket: string; partial: boolean }) => [s.bucket, s.partial])).toEqual([
      ["2026-09-14", true],
      ["2026-09-21", true],
    ]);

    // Re-importing must not reset an admin's metric settings.
    await request(app).post("/api/v1/metrics/import").set("authorization", a).attach("file", Buffer.from(csv), "kpis.csv").expect(201);
    const [again] = (await request(app).get("/api/v1/metrics").set("authorization", a)).body.data.filter(
      (m: { key: string }) => m.key === "resolution-time",
    );
    expect(again.aggregation).toBe("avg");

    const other = await request(app).get(`/api/v1/metrics/dashboard?days=7&to=${TO}`).set("authorization", b).expect(200);
    expect(other.body.kpis).toEqual([]);
    await request(app).delete(`/api/v1/metrics/${rt.id}`).set("authorization", b).expect(404);
  });

  it("exports Excel even when the AI service is unavailable", async () => {
    const a = await register("initech");
    await request(app).post("/api/v1/metrics/import").set("authorization", a).attach("file", Buffer.from(csv), "kpis.csv").expect(201);
    const res = await request(app)
      .get(`/api/v1/metrics/export?format=xlsx&days=7&to=${TO}`)
      .set("authorization", a)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("opsmind-kpis-2026-09-20-to-2026-09-26.xlsx");
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });

  it("caps distinct metrics per workspace", async () => {
    const a = await register("umbrella");
    const rows = Array.from({ length: 101 }, (_, i) => `2026-09-01,Metric ${i},1`);
    const res = await request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", a)
      .attach("file", Buffer.from(["date,metric,value", ...rows].join("\n")), "wide.csv")
      .expect(422);
    expect(res.body.error).toMatch(/up to 100/);
    const list = await request(app).get("/api/v1/metrics").set("authorization", a).expect(200);
    expect(list.body.data).toEqual([]); // the whole import rolled back
  });

  it("loads demo data for admins only", async () => {
    const a = await register("hooli");
    const created = await request(app).post("/api/v1/metrics/demo").set("authorization", a).expect(201);
    expect(created.body.imported).toEqual({ metrics: 6, points: 1080 });
    const list = await request(app).get("/api/v1/metrics").set("authorization", a).expect(200);
    expect(list.body.data.map((m: { name: string }) => m.name)).toContain("Customer satisfaction");
  });
});
