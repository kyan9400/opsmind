import { SpanStatusCode, context, trace, type Context } from "@opentelemetry/api";
import { UnrecoverableError } from "bullmq";
import { aiPost } from "./aiClient.js";
import { query } from "./db.js";

/**
 * Ingestion: the AI service extracts, chunks and embeds a stored document and marks it ready.
 *
 * Both modes share one retry policy. In queue mode BullMQ applies it to the worker's jobs (queue.ts,
 * worker.ts); in inline mode ingestDocument() applies it in-process.
 */
export const INGEST_ATTEMPTS = 3;
/** Exponential: waits 2 s, then 4 s, before the second and third attempts. */
export const INGEST_BACKOFF_MS = 2000;

export interface IngestResult {
  chunks?: number;
  ms?: number;
  detail?: string;
}

// A no-op tracer unless tracing.ts started the OpenTelemetry SDK.
const tracer = trace.getTracer("opsmind-ingest");

/**
 * One attempt. A missing document (404) or a file with no usable text (422) throws UnrecoverableError,
 * because retrying cannot help; anything else (AI service down, 5xx) throws a plain, retryable Error.
 *
 * One span per attempt under `parent`: the upload request's trace context, carried across the queue in
 * queue mode, so upload -> ingest reads as one trace. The HTTP call to the AI service nests under it.
 */
export function ingestOnce(documentId: string, attempt: number, parent: Context = context.active()) {
  return tracer.startActiveSpan(
    "ingest document",
    { attributes: { "document.id": documentId, "job.attempt": attempt } },
    parent,
    async (span) => {
      try {
        const { status, data } = await aiPost<IngestResult>("/v1/ingest", { document_id: documentId }, 120_000);
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
  );
}

/** After the last attempt. The AI service records its own failures; this covers it being unreachable. */
export async function markIngestFailed(documentId: string, message: string) {
  await query(
    `UPDATE documents SET status = 'failed', error = COALESCE(error, $2), updated_at = now()
      WHERE id = $1 AND status <> 'ready'`,
    [documentId, message.slice(0, 500)],
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inline mode: the worker's attempts, backoff, log lines and failure bookkeeping, in this process.
 * Never rejects, so a caller can hand the promise to waitUntil() and forget it.
 */
export async function ingestDocument(documentId: string): Promise<"ready" | "failed"> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await ingestOnce(documentId, attempt);
      console.log(JSON.stringify({ msg: "ingested", documentId, ...result }));
      return "ready";
    } catch (err) {
      const message = (err as Error).message;
      const final = err instanceof UnrecoverableError || attempt >= INGEST_ATTEMPTS;
      console.error(JSON.stringify({ msg: "ingest failed", documentId, final, error: message }));
      if (final) {
        await markIngestFailed(documentId, message).catch((dbErr: Error) =>
          console.error(JSON.stringify({ msg: "could not mark document failed", documentId, error: dbErr.message })),
        );
        return "failed";
      }
      await sleep(INGEST_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}
