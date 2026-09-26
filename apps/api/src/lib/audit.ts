import type pg from "pg";
import { pool } from "./db.js";

export async function audit(
  e: { tenantId: string; actorId: string | null; action: string; target?: string; meta?: object },
  client: pg.Pool | pg.PoolClient = pool,
) {
  await client.query(
    "INSERT INTO audit_log (tenant_id, actor_id, action, target, meta) VALUES ($1, $2, $3, $4, $5)",
    [e.tenantId, e.actorId, e.action, e.target ?? null, e.meta ?? {}],
  );
}
