import { context, propagation } from "@opentelemetry/api";
import { Queue, type ConnectionOptions } from "bullmq";
import { config } from "../config.js";

export const INGEST_QUEUE = "ingest";
export interface IngestJob {
  documentId: string;
  /** W3C trace context of the upload request, so the worker's processing joins the same trace. */
  trace?: Record<string, string>;
}

export function redisConnection(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    // Required by BullMQ workers: blocking commands must not be retried by ioredis.
    maxRetriesPerRequest: null,
  };
}

// Created lazily so processes that never enqueue (and unit tests) don't open a Redis connection.
let queue: Queue<IngestJob> | undefined;

function ingestQueue() {
  queue ??= new Queue<IngestJob>(INGEST_QUEUE, { connection: redisConnection() });
  return queue;
}

export async function enqueueIngest(documentId: string) {
  // Empty unless tracing is enabled; a job is a hop the HTTP instrumentation can't see on its own.
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  await ingestQueue().add(
    "ingest",
    { documentId, trace },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

export async function closeQueue() {
  await queue?.close();
  queue = undefined;
}

export const queueCounts = () => ingestQueue().getJobCounts("waiting", "active", "delayed", "failed");
