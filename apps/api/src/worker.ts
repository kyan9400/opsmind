import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { UnrecoverableError, Worker } from "bullmq";
import client from "@prometheus-io/client";
import { pool, query } from "./lib/db.js";
import { aiPost } from "./lib/aiClient.js";
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

// A no-op tracer unless tracing.ts started the OpenTelemetry SDK.
const tracer = trace.getTracer("opsmind-worker");

// Ingestion worker: hands each queued document to the AI service.
// Transient failures (AI down, 5xx) retry with exponential backoff; bad files fail immediately.
const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  (job) =>
    // One span per attempt; the HTTP call to the AI service (and its DB work) nests under it.
    tracer.startActiveSpan(
      "ingest document",
      { attributes: { "document.id": job.data.documentId, "job.attempt": job.attemptsMade + 1 } },
      async (span) => {
        try {
          const { status, data } = await aiPost<{ chunks?: number; ms?: number; detail?: string }>(
            "/v1/ingest",
            { document_id: job.data.documentId },
            120_000,
          );
          if (status === 422 || status === 404) throw new UnrecoverableError(data.detail ?? `ai service ${status}`);
          if (status !== 200) throw new Error(`ai service responded ${status}`);
          span.setAttribute("document.chunks", data.chunks ?? 0);
          return data;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      },
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
  if (final) {
    // The AI service records its own failures; this covers the case where it was unreachable.
    await query(
      `UPDATE documents SET status = 'failed', error = COALESCE(error, $2), updated_at = now()
        WHERE id = $1 AND status <> 'ready'`,
      [job.data.documentId, err.message.slice(0, 500)],
    );
  }
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
