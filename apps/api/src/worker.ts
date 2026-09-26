import { UnrecoverableError, Worker } from "bullmq";
import { pool, query } from "./lib/db.js";
import { aiPost } from "./lib/aiClient.js";
import { INGEST_QUEUE, redisConnection, type IngestJob } from "./lib/queue.js";

// Ingestion worker: hands each queued document to the AI service.
// Transient failures (AI down, 5xx) retry with exponential backoff; bad files fail immediately.
const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  async (job) => {
    const { status, data } = await aiPost<{ chunks?: number; ms?: number; detail?: string }>(
      "/v1/ingest",
      { document_id: job.data.documentId },
      120_000,
    );
    if (status === 422 || status === 404) throw new UnrecoverableError(data.detail ?? `ai service ${status}`);
    if (status !== 200) throw new Error(`ai service responded ${status}`);
    return data;
  },
  { connection: redisConnection(), concurrency: 2 },
);

worker.on("completed", (job, result) => {
  console.log(JSON.stringify({ msg: "ingested", documentId: job.data.documentId, ...result }));
});

worker.on("failed", async (job, err) => {
  if (!job) return;
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

console.log("opsmind worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close();
    await pool.end();
    process.exit(0);
  });
}
