import { context, propagation } from "@opentelemetry/api";
import { waitUntil } from "@vercel/functions";
import { Queue, type ConnectionOptions } from "bullmq";
import { config } from "../config.js";
import { INGEST_ATTEMPTS, INGEST_BACKOFF_MS, ingestDocument } from "./ingest.js";

export const INGEST_QUEUE = "ingest";
export interface IngestJob {
  documentId: string;
  /** W3C trace context of the upload request, so the worker's processing joins the same trace. */
  trace?: Record<string, string>;
}

export function redisConnection(): ConnectionOptions {
  if (!config.REDIS_URL) throw new Error("REDIS_URL is required for the ingestion queue (INGEST_MODE=queue)");
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    // Managed Redis (e.g. Upstash) authenticates an ACL user and only accepts TLS (a rediss:// URL).
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
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

/**
 * Hands a stored document over for indexing and returns without waiting for it.
 *
 * queue (default): a BullMQ job for the worker process.
 * inline: ingestion starts in this process. On Vercel, waitUntil() keeps the function alive after the
 * response until it ends (up to the function's time limit); elsewhere it is a no-op and the long-running
 * process simply finishes the work.
 */
export async function enqueueIngest(documentId: string) {
  if (config.INGEST_MODE === "inline") {
    waitUntil(ingestDocument(documentId));
    return;
  }
  // Empty unless tracing is enabled; a job is a hop the HTTP instrumentation can't see on its own.
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  await ingestQueue().add(
    "ingest",
    { documentId, trace },
    {
      attempts: INGEST_ATTEMPTS,
      backoff: { type: "exponential", delay: INGEST_BACKOFF_MS },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

export async function closeQueue() {
  await queue?.close();
  queue = undefined;
}

// Inline mode has no queue: report it empty rather than dial a Redis that is not there on every scrape.
export const queueCounts = async (): Promise<Record<string, number>> =>
  config.INGEST_MODE === "inline"
    ? { waiting: 0, active: 0, delayed: 0, failed: 0 }
    : ingestQueue().getJobCounts("waiting", "active", "delayed", "failed");
