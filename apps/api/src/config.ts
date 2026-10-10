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
    // true opens POST /api/v1/sandbox: anyone can create a temporary private workspace with sample data.
    ALLOW_SANDBOX: flag(false),
    // How long a sandbox, and its token, lasts. Short, so the SANDBOX_MAX_ACTIVE slots turn over several
    // times a day; the next creation deletes expired sandboxes and reuses their space.
    SANDBOX_TTL_HOURS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(3)),
    // Sandbox creations per client IP per hour; 0 disables (browser tests).
    SANDBOX_RATE_LIMIT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(3)),
    // Unexpired sandboxes at once. The per-IP limit is per instance on serverless hosts, so this cap (with
    // the per-sandbox budgets below) is what bounds the space sandboxes can take in a small free database.
    SANDBOX_MAX_ACTIVE: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(20)),
    // Documents per sandbox, the 4 sample ones included.
    SANDBOX_MAX_DOCUMENTS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(10)),
    // Total size of the files in one sandbox, samples included. Indexed text costs about 15 times its size
    // in chunks, embeddings and their indexes (~10 KB per 700 characters). A PDF's text can outgrow its file;
    // the AI service caps each document (INGEST_MAX_CHARS / INGEST_MAX_CHUNKS, ~3 MB of chunks), so a full
    // sandbox takes up to ~20 MB and SANDBOX_MAX_ACTIVE of them stay below 500 MB; the brake below is the backstop.
    SANDBOX_MAX_BYTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1024 * 1024)),
    // Largest single file (document or KPI CSV) a sandbox may upload; MAX_UPLOAD_BYTES still applies on top.
    // Not lowered to the AI service's text limit (~200,000 characters): a PDF carries fonts and images, so an
    // ordinary one is several times larger than its text. A plain-text file over ~180 KB is accepted and then
    // fails indexing with "document too long".
    SANDBOX_MAX_FILE_BYTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(512 * 1024)),
    // KPI data points one sandbox may hold in total, across all imports (the samples are 180 days x 6
    // metrics = 1,080 of them). A cap per import alone would let repeated imports grow without bound.
    SANDBOX_MAX_CSV_ROWS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(5000)),
    // Uploads, re-indexes, CSV imports and demo loads per sandbox per hour; 0 disables. Counted in memory and
    // again in the database (audit log), so the limit also holds across serverless instances. A third of
    // the budget below, so one sandbox cannot spend the uploads of all the others.
    SANDBOX_WRITE_RATE_LIMIT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(10)),
    // Uploads and re-indexes of all sandboxes together, per hour; 0 disables. One visitor can hold several
    // sandboxes, and each of these writes is an indexing run on the host's monthly CPU quota (4 h on Vercel
    // Hobby).
    SANDBOX_GLOBAL_WRITE_RATE_LIMIT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(30)),
    // Global brake: while the database is larger than this (pg_database_size), sandbox creation and sandbox
    // writes answer 503. It sits below Supabase Free's 500 MB, where the whole project turns read-only (the
    // demo login included). 0 disables.
    SANDBOX_DB_BRAKE_BYTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(350 * 1024 * 1024)),
  })
  .transform((env) => ({
    ...env,
    // BullMQ cannot run without Redis, so queue mode keeps the local default it always had.
    REDIS_URL: env.REDIS_URL ?? (env.INGEST_MODE === "queue" ? "redis://localhost:6379" : undefined),
  }));

export const config = Env.parse(process.env);
