import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.PG_POOL_MAX });

// An idle client whose server connection goes away (a database restart, Neon suspending an idle compute)
// emits "error" on the pool, and an unhandled "error" event would crash the process. pg has already
// dropped that client; the next query opens a fresh connection.
pool.on("error", (err) => console.error(JSON.stringify({ msg: "idle database client failed", error: err.message })));

// On Vercel this closes idle clients before a function instance is suspended, so a resumed instance
// never reuses a dead socket. Anywhere else (no VERCEL_URL/VERCEL_REGION) it does nothing.
attachDatabasePool(pool);

export async function query<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
