/**
 * "Try it with your own data": a temporary private workspace per visitor, seeded like the public demo
 * (180 days of KPIs and the 4 sample documents), whose owner is the visitor's browser. It expires after
 * SANDBOX_TTL_HOURS; requireAuth rejects its token from then on and the daily cron deletes it.
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

export const SANDBOX_TTL_HOURS = 24;
export const SANDBOX_TENANT_NAME = "Sandbox workspace";

// Next to the migration and seed locks: concurrent creations take turns at the active-sandbox count.
const SANDBOX_LOCK_ID = 7_274_003;

/**
 * Unguessable and never deliverable: .invalid does not resolve (RFC 2606) and the API refuses it for
 * accounts created any other way (schemas.ts), so nobody can sign up as, or receive mail for, it.
 */
export const sandboxOwnerEmail = () => `sandbox+${randomBytes(16).toString("hex")}@sandbox.invalid`;

export async function createSandbox(): Promise<{ token: string; expiresAt: string }> {
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
      [SANDBOX_TENANT_NAME, SANDBOX_TTL_HOURS],
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
    token: signToken({ sub: created.userId, tenantId: created.tenantId, role: "owner" }, "24h"),
    expiresAt: created.expiresAt.toISOString(),
  };
}

/** Deletes every expired sandbox with everything in it (ON DELETE CASCADE). Permanent tenants have no expiry. */
export async function deleteExpiredSandboxes(): Promise<number> {
  const rows = await query<{ id: string }>(
    "DELETE FROM tenants WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id",
  );
  return rows.length;
}
