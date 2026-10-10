import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../src/lib/metrics.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

// The serverless profile: inline ingestion and no REDIS_URL. Read when the modules load, hence
// resetModules + dynamic imports with the variables set.
async function load() {
  vi.resetModules();
  process.env.INGEST_MODE = "inline";
  delete process.env.REDIS_URL;
  const series = { points: [{ day: "2026-09-26", value: 150 }] };
  const aiPost = vi.fn(async () => ({
    status: 200,
    data: { anomalies: [], summary: "Revenue is up 50%.", provider: "workers-ai", ms: 900 },
  }));
  vi.doMock("../src/lib/aiClient.js", () => ({ aiPost }));
  vi.doMock("../src/lib/metrics.js", () => ({ getDailySeries: async () => new Map([["m1", series.points]]) }));
  const { getInsights } = await import("../src/lib/insights.js");
  const cache = await import("../src/lib/redis.js");
  return { getInsights, aiPost, series, cache };
}

afterEach(() => {
  delete process.env.INGEST_MODE;
  vi.useRealTimers();
  vi.doUnmock("../src/lib/aiClient.js");
  vi.doUnmock("../src/lib/metrics.js");
});

const dashboard = (current = 1050): Dashboard => ({
  period: { from: "2026-09-20", to: "2026-09-26" },
  previousPeriod: { from: "2026-09-13", to: "2026-09-19" },
  bucket: "day",
  kpis: [
    {
      id: "m1",
      key: "revenue",
      name: "Revenue",
      unit: "$",
      aggregation: "sum",
      direction: "up",
      current,
      previous: 700,
      deltaPct: 50,
      series: [],
    },
  ],
});

describe("insights cache without Redis", () => {
  it("reuses a summary on this instance for 10 minutes instead of asking the AI service again", async () => {
    vi.useFakeTimers();
    const { getInsights, aiPost, cache } = await load();
    expect(cache.sharedCache()).toBe(false);

    const first = await getInsights("t1", dashboard());
    expect(first).toMatchObject({ summary: "Revenue is up 50%.", provider: "workers-ai" });
    // A copy: changing what one request got does not change what the next one gets.
    first.summary = "changed";
    expect(await getInsights("t1", dashboard())).toMatchObject({ summary: "Revenue is up 50%." });
    expect(aiPost).toHaveBeenCalledTimes(1);
    // Another tenant with the same numbers has entries of its own.
    await getInsights("t2", dashboard());
    expect(aiPost).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(600_000);
    await getInsights("t1", dashboard());
    expect(aiPost).toHaveBeenCalledTimes(3);
  });

  it("never serves insights on data that changed, even when another instance wrote it", async () => {
    const { getInsights, aiPost, series } = await load();
    await getInsights("t1", dashboard());
    // A CSV import served by another instance: no version bump reaches this one, but the data differs.
    series.points = [{ day: "2026-09-26", value: 90 }];
    await getInsights("t1", dashboard());
    expect(aiPost).toHaveBeenCalledTimes(2);
    await getInsights("t1", dashboard(990));
    expect(aiPost).toHaveBeenCalledTimes(3);
    await getInsights("t1", dashboard(990));
    expect(aiPost).toHaveBeenCalledTimes(3);
  });

  it("holds a bounded number of entries, dropping the oldest first", async () => {
    const { cache } = await load();
    for (let i = 0; i <= 200; i++) await cache.cacheSet(`k${i}`, { i }, 600);
    expect(await cache.cacheGet("k0")).toBeNull();
    expect(await cache.cacheGet("k1")).toEqual({ i: 1 });
    expect(await cache.cacheGet("k200")).toEqual({ i: 200 });
  });
});
