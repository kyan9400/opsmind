/**
 * Seeds the public demo workspace (see lib/demoSeed.ts): a read-only "viewer" login for visitors,
 * 180 days of KPIs and a few company documents to ask questions about.
 *
 *   DEMO_EMAIL=demo@opsmind.dev DEMO_PASSWORD=... node dist/seedDemo.js
 *
 * Idempotent: safe to re-run at any time. With INGEST_MODE=inline it also indexes the documents
 * before exiting, and exits non-zero if any could not be indexed.
 */
import { pool } from "./lib/db.js";
import { demoSeedOptions, seedDemo } from "./lib/demoSeed.js";
import { closeQueue } from "./lib/queue.js";
import { closeRedis } from "./lib/redis.js";

try {
  const result = await seedDemo(demoSeedOptions());
  console.log(JSON.stringify(result));
  // Inline indexing ran in this process: a failure means the AI service was unreachable or rejected the
  // token, which whoever ran the seed (CI, the demo-db workflow) needs to see.
  if ("documentsFailed" in result && result.documentsFailed > 0) process.exitCode = 1;
} finally {
  await closeQueue();
  await closeRedis();
  await pool.end();
}
