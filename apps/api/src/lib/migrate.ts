import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

// Minimal forward-only migrator: applies each migrations/*.sql once, in order.
const dir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Several processes can start at once (API replicas, a Kubernetes rollout, compose restarts).
// A session-level advisory lock makes them take turns; the late ones find nothing left to apply.
const MIGRATION_LOCK_ID = 7_274_001;

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
  );
  const applied = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );

  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    // Each migration and its bookkeeping row commit together, so a crash can't leave one half-recorded.
    await client.query("BEGIN");
    try {
      await client.query(await readFile(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    console.log(`applied ${file}`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
  client.release();
  await pool.end();
}
