/**
 * Budgets that keep anonymous sandbox workspaces from filling a small free database (Supabase Free turns
 * the whole project read-only at 500 MB, the demo login included) or spending the host's CPU quota:
 *
 * - a global brake on the database size, for sandbox creation and every sandbox write;
 * - writes per hour, per sandbox, and the ones that index a document for all sandboxes together;
 * - per sandbox: documents and bytes (here) and KPI data points (lib/metrics.ts).
 *
 * The checks run inside the write's own transaction, after reserveSandboxWrite() has taken its locks, so
 * parallel requests take turns instead of all passing the same count.
 */
import type pg from "pg";
import { config } from "../config.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";
import { formatBytes } from "./files.js";

/** pg_database_size() stats every file of the database; once a minute per instance is enough for a brake. */
export const DB_SIZE_TTL_MS = 60_000;

let measured: { bytes: number; at: number } | undefined;
let measuring: Promise<number> | undefined;

/** The database size in bytes, cached for DB_SIZE_TTL_MS. Concurrent callers share one query. */
export function databaseBytes(): Promise<number> {
  if (measured && Date.now() - measured.at < DB_SIZE_TTL_MS) return Promise.resolve(measured.bytes);
  measuring ??= query<{ bytes: string }>("SELECT pg_database_size(current_database()) AS bytes")
    .then(([row]) => {
      measured = { bytes: Number(row.bytes), at: Date.now() };
      return measured.bytes;
    })
    .finally(() => {
      measuring = undefined;
    });
  return measuring;
}

/**
 * 503 while the database is larger than SANDBOX_DB_BRAKE_BYTES. The cached size is compared with the
 * current setting on every call, so a changed threshold applies at once. Deleted rows leave free space
 * for new ones but the size only drops after a VACUUM FULL, so once on, the brake usually stays on until
 * then (or until the threshold is raised).
 * It is checked before a write, so it limits how far sandboxes grow, not what one upload adds: that is
 * bounded by the per-sandbox budgets and the AI service's per-document limits.
 */
export async function assertDatabaseHasRoom() {
  const limit = config.SANDBOX_DB_BRAKE_BYTES;
  if (limit > 0 && (await databaseBytes()) > limit) {
    throw new HttpError(
      503,
      "temporary workspaces are paused because the demo database is nearly full, try again later",
    );
  }
}

/** The writes the hourly budgets count. Each one leaves exactly one audit row with this action. */
export const SANDBOX_WRITE_ACTIONS = [
  "document.uploaded",
  "document.reindexed",
  "metrics.imported",
  "metrics.demo_loaded",
] as const;
export type SandboxWriteAction = (typeof SANDBOX_WRITE_ACTIONS)[number];

/**
 * The ones the all-sandboxes budget counts: they index a document, the CPU work that budget is for. A CSV
 * import or a demo load only upserts KPI rows, which each sandbox's point budget already bounds. Counted
 * there, they would let one visitor spend everyone's uploads on harmless repeats (reloading the samples).
 */
export const SANDBOX_INDEXING_ACTIONS: readonly SandboxWriteAction[] = ["document.uploaded", "document.reindexed"];

// Next to the sandbox creation lock (7_274_003): sandbox writes take turns at the all-sandboxes count.
const SANDBOX_WRITE_LOCK_ID = 7_274_004;

/**
 * Locks the sandbox's tenant row until the transaction ends, then checks the hourly write budgets against
 * the audit log: SANDBOX_WRITE_RATE_LIMIT for this sandbox, then, for a write that indexes a document,
 * SANDBOX_GLOBAL_WRITE_RATE_LIMIT for all of them (under an advisory lock, since the tenant lock does not
 * stop other sandboxes). The in-memory limiter is per serverless instance; these counts hold across all of
 * them. The caller writes its audit row (`action`) in the same transaction, so the next writer (waiting on
 * the lock) counts it.
 */
export async function reserveSandboxWrite(tx: pg.PoolClient, tenantId: string, action: SandboxWriteAction) {
  await tx.query("SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  const limit = config.SANDBOX_WRITE_RATE_LIMIT;
  if (limit > 0) {
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

  const globalLimit = config.SANDBOX_GLOBAL_WRITE_RATE_LIMIT;
  if (globalLimit > 0 && SANDBOX_INDEXING_ACTIONS.includes(action)) {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SANDBOX_WRITE_LOCK_ID]);
    // Sandboxes only (expires_at set, the partial tenants_expires_idx), then audit_tenant_time_idx per
    // sandbox. Expired and ended sandboxes count too: the cleanup keeps them until these rows are an hour
    // old (lib/sandbox.ts), since they would go with them.
    const {
      rows: [{ n }],
    } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants t JOIN audit_log a ON a.tenant_id = t.id
        WHERE t.expires_at IS NOT NULL AND a.action = ANY($1::text[]) AND a.created_at > now() - interval '1 hour'`,
      [SANDBOX_INDEXING_ACTIONS],
    );
    if (n >= globalLimit) {
      throw new HttpError(
        503,
        "temporary workspaces have reached their document uploads for this hour, try again later",
      );
    }
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
