/**
 * Per-sandbox budgets that keep anonymous sandbox workspaces from filling a small free database (Supabase
 * Free turns the whole project read-only at 500 MB, the demo login included) or spending the host's CPU
 * quota: writes per hour, documents and bytes (here) and KPI data points (lib/metrics.ts).
 *
 * They run inside the write's own transaction, after reserveSandboxWrite() has locked the tenant row, so
 * parallel requests of one sandbox take turns instead of all passing the same count.
 */
import type pg from "pg";
import { config } from "../config.js";
import { HttpError } from "./errors.js";
import { formatBytes } from "./files.js";

/** The writes SANDBOX_WRITE_RATE_LIMIT counts. Each one leaves exactly one audit row with this action. */
export const SANDBOX_WRITE_ACTIONS = [
  "document.uploaded",
  "document.reindexed",
  "metrics.imported",
  "metrics.demo_loaded",
];

/**
 * Locks the sandbox's tenant row until the transaction ends, then checks the hourly write budget against
 * the audit log. The in-memory limiter is per serverless instance; this count holds across all of them.
 * The caller writes its audit row in the same transaction, so the next writer (waiting on the lock)
 * counts it.
 */
export async function reserveSandboxWrite(tx: pg.PoolClient, tenantId: string) {
  await tx.query("SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  const limit = config.SANDBOX_WRITE_RATE_LIMIT;
  if (limit === 0) return;
  const {
    rows: [{ n }],
  } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = $1 AND action = ANY($2::text[]) AND created_at > now() - interval '1 hour'`,
    [tenantId, SANDBOX_WRITE_ACTIONS],
  );
  if (n >= limit) {
    throw new HttpError(429, `a temporary workspace allows ${limit} uploads and imports per hour, try again later`);
  }
}

/**
 * Document count and total bytes of a sandbox, checked before a new file of `sizeBytes` is stored.
 * Call after reserveSandboxWrite(): its lock is what makes this count-then-insert safe.
 */
export async function assertDocumentBudget(tx: pg.PoolClient, tenantId: string, sizeBytes: number) {
  const {
    rows: [{ n, bytes }],
  } = await tx.query<{ n: number; bytes: number }>(
    "SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::float8 AS bytes FROM documents WHERE tenant_id = $1",
    [tenantId],
  );
  if (n >= config.SANDBOX_MAX_DOCUMENTS) {
    throw new HttpError(403, `a temporary workspace holds at most ${config.SANDBOX_MAX_DOCUMENTS} documents`);
  }
  if (bytes + sizeBytes > config.SANDBOX_MAX_BYTES) {
    throw new HttpError(
      413,
      `a temporary workspace holds at most ${formatBytes(config.SANDBOX_MAX_BYTES)} of documents ` +
        `(${formatBytes(bytes)} used), delete one to make room`,
    );
  }
}
