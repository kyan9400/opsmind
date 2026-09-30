import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { context, propagation } from "@opentelemetry/api";
import { UnrecoverableError, Worker } from "bullmq";
import client from "@prometheus-io/client";
import { pool } from "./lib/db.js";
import { ingestOnce, markIngestFailed } from "./lib/ingest.js";
import { INGEST_QUEUE, redisConnection, type IngestJob } from "./lib/queue.js";
import { createRegistry } from "./lib/telemetry.js";

const registry = createRegistry("worker");
const jobDuration = new client.Histogram({
  name: "opsmind_ingest_job_duration_seconds",
  help: "Time from a worker picking up an ingestion job to it finishing",
  labelNames: ["outcome"],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});
const jobsTotal = new client.Counter({
  name: "opsmind_ingest_jobs_total",
  help: "Ingestion job attempts by outcome",
  labelNames: ["outcome"],
  registers: [registry],
});

// Ingestion worker: hands each queued document to the AI service.
// Transient failures (AI down, 5xx) retry with exponential backoff; bad files fail immediately.
const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  // The attempt's span is parented to the upload request that enqueued the job.
  (job) =>
    ingestOnce(
      job.data.documentId,
      job.attemptsMade + 1,
      propagation.extract(context.active(), job.data.trace ?? {}),
    ),
  { connection: redisConnection(), concurrency: 2 },
);

function observe(job: { processedOn?: number; finishedOn?: number }, outcome: "completed" | "failed") {
  jobsTotal.inc({ outcome });
  if (job.processedOn && job.finishedOn) jobDuration.observe({ outcome }, (job.finishedOn - job.processedOn) / 1000);
}

worker.on("completed", (job, result) => {
  observe(job, "completed");
  console.log(JSON.stringify({ msg: "ingested", documentId: job.data.documentId, ...result }));
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  observe(job, "failed");
  const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  console.error(JSON.stringify({ msg: "ingest failed", documentId: job.data.documentId, final, error: err.message }));
  if (final) await markIngestFailed(job.data.documentId, err.message);
});

// The worker has no HTTP API, so it serves its Prometheus metrics on a dedicated port.
const metricsServer = createServer(async (req, res) => {
  if (req.url !== "/metrics") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
}).listen(Number(process.env.WORKER_METRICS_PORT ?? 9100));

// Liveness heartbeat for container healthchecks: touched only while the worker is connected and running.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/worker-heartbeat";
const heartbeat = setInterval(() => {
  if (worker.isRunning()) writeFile(HEARTBEAT_FILE, String(Date.now())).catch(() => {});
}, 5_000);

console.log("opsmind worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(heartbeat);
    metricsServer.close();
    await worker.close();
    await pool.end();
    process.exit(0);
  });
}
