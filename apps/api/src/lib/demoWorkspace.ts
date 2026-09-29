import type pg from "pg";

/**
 * The seeded owner of a demo workspace; the tenant id prefix ties it to that one workspace. The
 * `.invalid` domain is refused for accounts created through the API (schemas.ts).
 */
export const demoOwnerEmail = (tenantId: string) => `owner+${tenantId.slice(0, 8)}@demo.invalid`;

export interface DemoAccounts {
  /** The public login; always a viewer. */
  email: string;
  tenantName: string;
  viewerHash: string;
  /** Of a random password nobody knows: the workspace needs an owner, but nobody may log in as one. */
  ownerHash: string;
}

/**
 * Creates the demo workspace, or takes back the one an earlier run created, inside the caller's
 * transaction. Throws when `email` belongs to any other workspace. Afterwards the workspace holds only
 * the seeded owner and the viewer, with fresh passwords and their original roles.
 */
export async function claimDemoWorkspace(tx: pg.PoolClient, a: DemoAccounts) {
  const existing = await tx.query<{ tenant_id: string; tenant_name: string; viewer_seeded: boolean }>(
    `SELECT u.tenant_id, t.name AS tenant_name, u.created_at = t.created_at AS viewer_seeded
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1`,
    [a.email],
  );
  let tenantId: string;
  if (existing.rows[0]) {
    const { tenant_id, tenant_name, viewer_seeded } = existing.rows[0];
    tenantId = tenant_id;
    // Only reuse a workspace created here: resetting the password of someone's real account and
    // publishing it as the demo login would hand their workspace to every visitor. The tenant, owner
    // and viewer are inserted in one transaction and so share its now(); a look-alike owner account
    // added to someone else's workspace later cannot carry the tenant's creation time.
    const owner = await tx.query(
      `SELECT 1 FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.email = $2 AND u.created_at = t.created_at`,
      [tenantId, demoOwnerEmail(tenantId)],
    );
    if (tenant_name !== a.tenantName || !viewer_seeded || owner.rowCount === 0) {
      throw new Error(
        `${a.email} belongs to a workspace this script did not create (or DEMO_TENANT_NAME changed); ` +
          "refusing to turn it into the public demo. Use another DEMO_EMAIL.",
      );
    }
    await tx.query("UPDATE users SET password_hash = $1, role = 'owner' WHERE tenant_id = $2 AND email = $3", [
      a.ownerHash,
      tenantId,
      demoOwnerEmail(tenantId),
    ]);
    await tx.query("UPDATE users SET password_hash = $1, role = 'viewer' WHERE tenant_id = $2 AND email = $3", [
      a.viewerHash,
      tenantId,
      a.email,
    ]);
  } else {
    const tenant = await tx.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [
      a.tenantName,
    ]);
    tenantId = tenant.rows[0].id;
    await tx.query(
      `INSERT INTO users (tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Workspace owner', $3, 'owner')`,
      [tenantId, demoOwnerEmail(tenantId), a.ownerHash],
    );
    await tx.query(
      `INSERT INTO users (tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Demo visitor', $3, 'viewer')`,
      [tenantId, a.email, a.viewerHash],
    );
  }
  // Only the seeded owner and the viewer may exist here, so no other account in the shared workspace
  // (however it got there) keeps access past the next run.
  const removed = await tx.query("DELETE FROM users WHERE tenant_id = $1 AND email <> ALL($2::text[])", [
    tenantId,
    [demoOwnerEmail(tenantId), a.email],
  ]);
  return { tenantId, removedUsers: removed.rowCount ?? 0 };
}
