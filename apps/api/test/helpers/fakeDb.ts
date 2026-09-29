/**
 * Stand-in for src/lib/db.ts in the "no database" unit tests:
 *
 *   vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));
 *
 * requireAuth looks up the caller's current role on every request, so this answers that one query
 * from an in-memory users table. Every other query fails, like an unreachable Postgres would.
 */
import { vi } from "vitest";
import { signToken } from "../../src/lib/auth.js";
import type { Role } from "../../src/lib/rbac.js";

export const users = new Map<string, { tenantId: string; role: Role }>();

const noDatabase = () => Promise.reject(new Error("no database in unit tests"));

export const query = vi.fn(async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
  if (text.startsWith("SELECT role FROM users WHERE id = $1 AND tenant_id = $2")) {
    const user = users.get(params[0] as string);
    return user && user.tenantId === params[1] ? [{ role: user.role }] : [];
  }
  return noDatabase();
});
export const withTx = vi.fn(noDatabase);
export const pool = { query: noDatabase, connect: noDatabase, end: async () => {} };

/** Puts a user in the fake table and returns an Authorization header carrying its token. */
export function bearer(role: Role, { sub = `user-${role}`, tenantId = "t1" } = {}) {
  users.set(sub, { tenantId, role });
  return `Bearer ${signToken({ sub, tenantId, role })}`;
}
