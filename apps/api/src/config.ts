import { z } from "zod";

// Hosting dashboards store a cleared field as an empty string; the settings wrapped in this treat it as
// unset so the default applies.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** An on/off switch: true/false or 1/0. (z.coerce.boolean() would read the string "false" as true.) */
const flag = (fallback: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" ? blankToUndefined(v.trim().toLowerCase()) : v),
    z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => (v === undefined ? fallback : v === "true" || v === "1")),
  );

const Env = z
  .object({
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(16),
    API_PORT: z.coerce.number().default(4000),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Queue mode needs it (and falls back to a local Redis, below); inline mode uses it only for the
    // insights cache, and runs uncached without it.
    REDIS_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
    // A trailing slash would turn "/v1/ask" into "//v1/ask", which the AI service answers with 404.
    AI_SERVICE_URL: z
      .string()
      .url()
      .default("http://localhost:8000")
      .transform((u) => u.replace(/\/+$/, "")),
    AI_SERVICE_TOKEN: z.string().min(16).default("dev-internal-token-change-me"),
    // Number of reverse proxies in front of the API (1 behind Caddy), so rate limits see real client IPs.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Login/register attempts per IP per 15 minutes; 0 disables (tests).
    AUTH_RATE_LIMIT: z.coerce.number().int().min(0).default(20),
    // AI-backed requests (ask, insights, report exports) per user and client IP per minute, with 10x that
    // per user across all IPs; 0 disables (load tests).
    AI_RATE_LIMIT: z.coerce.number().int().min(0).default(20),
    // queue: uploads become BullMQ jobs for the worker process (compose, Helm, Codespaces).
    // inline: the API ingests in-process after answering, for serverless hosts with no worker and no Redis.
    INGEST_MODE: z.enum(["queue", "inline"]).default("queue"),
    // Postgres connections per API process. Serverless runs many small instances against one pooled database.
    // (z.coerce.number() alone would read a blank value as 0 and refuse to start.)
    PG_POOL_MAX: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(10)),
    // Largest document upload. Vercel refuses request bodies over 4.5 MB, so the live demo sets 4 MB.
    MAX_UPLOAD_BYTES: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(10 * 1024 * 1024)),
    // false closes self-service sign-up: the public demo's small database holds only the seeded workspace.
    ALLOW_REGISTRATION: flag(true),
    // false removes GET /metrics. With no private network or proxy in front (Vercel), it would be public.
    METRICS_PUBLIC: flag(true),
    // Enables GET /api/internal/cron/* for callers sending "Authorization: Bearer <CRON_SECRET>" (Vercel Cron does).
    CRON_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
  })
  .transform((env) => ({
    ...env,
    // BullMQ cannot run without Redis, so queue mode keeps the local default it always had.
    REDIS_URL: env.REDIS_URL ?? (env.INGEST_MODE === "queue" ? "redis://localhost:6379" : undefined),
  }));

export const config = Env.parse(process.env);
