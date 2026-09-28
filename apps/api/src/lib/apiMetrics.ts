import client from "@prometheus-io/client";
import { queueCounts } from "./queue.js";
import { createRegistry } from "./telemetry.js";

export const registry = createRegistry("api");

export const insightsCache = new client.Counter({
  name: "opsmind_insights_cache_total",
  help: "AI insights served from the Redis cache vs recomputed",
  labelNames: ["result"],
  registers: [registry],
});

const QUEUE_STATES = ["waiting", "active", "delayed", "failed"] as const;

new client.Gauge({
  name: "opsmind_queue_jobs",
  help: "Ingestion jobs by state, sampled at scrape time",
  labelNames: ["queue", "state"],
  registers: [registry],
  async collect() {
    // A scrape must never hang on Redis: give up after 1s and keep the last values.
    const counts = await Promise.race([
      queueCounts().catch(() => null),
      new Promise<null>((resolve) => setTimeout(resolve, 1000, null)),
    ]);
    if (!counts) return;
    for (const state of QUEUE_STATES) this.set({ queue: "ingest", state }, counts[state] ?? 0);
  },
});
