/**
 * "Try it with your own data": a temporary private workspace per visitor, seeded like the public demo
 * (180 days of KPIs and the 4 sample documents), whose owner is the visitor's browser. It expires after
 * SANDBOX_TTL_HOURS, or when its owner ends it (endSandbox); requireAuth rejects its token from then on.
 * It is deleted by the next sandbox creation (a small batch of the oldest expired ones each time) or by
 * the daily cron, whichever is first.
 */
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { audit } from "./audit.js";
import { hashPassword, signToken } from "./auth.js";
import { query, withTx } from "./db.js";
import { todayUtc } from "./dates.js";
import { generateDemoData } from "./demoData.js";
import { insertDemoDocuments } from "./demoSeed.js";
import { HttpError } from "./errors.js";
import { importDemo } from "./metrics.js";
import { enqueueIngestAll } from "./queue.js";
import { assertDatabaseHasRoom, SANDBOX_INDEXING_ACTIONS } from "./sandboxLimits.js";

export const SANDBOX_TENANT_NAME = "Sandbox workspace";

/** Expired sandboxes a creation deletes on its way: small, so a visitor never waits on a big cleanup. */
export const SANDBOX_PURGE_BATCH = 10;

// Next to the migration and seed locks: concurrent creations take turns at the active-sandbox count.
const SANDBOX_LOCK_ID = 7_274_003;

/**
 * Unguessable and never deliverable: .invalid does not resolve (RFC 2606) and the API refuses it for
 * accounts created any other way (schemas.ts), so nobody can sign up as, or receive mail for, it.
 */
export const sandboxOwnerEmail = () => `sandbox+${randomBytes(16).toString("hex")}@sandbox.invalid`;

export async function createSandbox(): Promise<{ token: string; expiresAt: string }> {
  // Delete expired sandboxes now rather than at the next daily cron (up to a day later), so new rows reuse
  // their space. That does not release a tripped brake: pg_database_size only drops after a VACUUM FULL.
  // Outside the transaction below, so a creation the brake or the cap refuses still keeps the cleanup.
  await deleteExpiredSandboxes(SANDBOX_PURGE_BATCH).catch((err: Error) =>
    console.error(JSON.stringify({ msg: "expired sandbox cleanup failed", error: err.message })),
  );
  await assertDatabaseHasRoom();

  // A password nobody knows, not even the visitor: the token is the only way in.
  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));

  const created = await withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SANDBOX_LOCK_ID]);
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tenants WHERE expires_at > now()",
    );
    if (rows[0].n >= config.SANDBOX_MAX_ACTIVE) {
      throw new HttpError(503, "too many temporary workspaces right now, try again later");
    }
    const tenant = await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO tenants (name, expires_at) VALUES ($1, now() + make_interval(hours => $2))
       RETURNING id, expires_at`,
      [SANDBOX_TENANT_NAME, config.SANDBOX_TTL_HOURS],
    );
    const { id: tenantId, expires_at } = tenant.rows[0];
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Sandbox owner', $3, 'owner') RETURNING id`,
      [tenantId, sandboxOwnerEmail(), passwordHash],
    );
    const documents = await insertDemoDocuments(tx, tenantId);
    await audit({ tenantId, actorId: user.rows[0].id, action: "sandbox.created", meta: { expiresAt: expires_at } }, tx);
    return { tenantId, userId: user.rows[0].id, expiresAt: expires_at, documents };
  });

  try {
    await importDemo(created.tenantId, generateDemoData(todayUtc()));
    // Answer now and index in the background (inline: waitUntil, queue: the worker). Four short documents
    // take seconds, but waiting would put a cold AI service's retries inside the 300 s Vercel limit and
    // keep the visitor staring at a spinner; the Documents page already polls until they are ready.
    await enqueueIngestAll(created.documents);
  } catch (err) {
    // Half-seeded is worse than nothing: the visitor never gets this token, so nobody would see the rest.
    await query("DELETE FROM tenants WHERE id = $1", [created.tenantId]).catch(() => {});
    throw err;
  }

  return {
    token: signToken({ sub: created.userId, tenantId: created.tenantId, role: "owner" }, config.SANDBOX_TTL_HOURS),
    expiresAt: created.expiresAt.toISOString(),
  };
}

/**
 * An expired sandbox `t` that can go. One that indexed a document in the last hour waits while the
 * all-sandboxes write budget is on: that budget counts those writes through its audit rows, which go with
 * it, so deleting it at once would hand its share of the hour straight back (create, upload, end, repeat).
 * $2 is SANDBOX_INDEXING_ACTIONS, $3 whether the budget is on (deletable() fills both).
 */
const DELETABLE = `t.expires_at IS NOT NULL AND t.expires_at <= now()
  AND (NOT $3::boolean OR NOT EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.tenant_id = t.id AND a.action = ANY($2::text[]) AND a.created_at > now() - interval '1 hour'))`;
const deletable = () => [SANDBOX_INDEXING_ACTIONS, config.SANDBOX_GLOBAL_WRITE_RATE_LIMIT > 0];

/**
 * Deletes expired sandboxes with everything in them (ON DELETE CASCADE), the oldest first, at most `limit`
 * (all of them without one). Permanent tenants have no expiry. SKIP LOCKED lets concurrent cleanups (two
 * creations, or a creation and the cron) take different rows instead of waiting for each other.
 */
export async function deleteExpiredSandboxes(limit?: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM tenants WHERE id IN (
       SELECT id FROM tenants t WHERE ${DELETABLE}
        ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    // LIMIT NULL means no limit.
    [limit ?? null, ...deletable()],
  );
  return rows.length;
}

/**
 * Ends a sandbox before its time, at its owner's request (DELETE /api/v1/sandbox): its token stops working
 * and its slot frees up at once. Its data is deleted at once too, unless it indexed a document in the last
 * hour; then the cleanup deletes it once that hour has passed, like any expired sandbox (see DELETABLE).
 * Both statements match sandboxes only (expires_at set), so a permanent workspace is never touched.
 */
export async function endSandbox(tenantId: string) {
  await query("UPDATE tenants SET expires_at = now() WHERE id = $1 AND expires_at > now()", [tenantId]);
  await query(`DELETE FROM tenants t WHERE t.id = $1 AND ${DELETABLE}`, [tenantId, ...deletable()]);
}
