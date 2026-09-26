import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

// Minimal forward-only migrator: applies each migrations/*.sql once, in order.
const dir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

await pool.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
);
const applied = new Set(
  (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
);

for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  await pool.query(await readFile(join(dir, file), "utf8"));
  await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  console.log(`applied ${file}`);
}
await pool.end();
