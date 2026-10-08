/**
 * Stand-in for src/lib/db.ts in the "no database" unit tests:
 *
 *   vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));
 *
 * requireAuth looks up the caller's current role on every request, so this answers that one query
 * from an in-memory users table. A test can answer more queries through `answers`; every other query
 * fails, like an unreachable Postgres would.
 */
import { vi } from "vitest";
import { signToken } from "../../src/lib/auth.js";
import type { Role } from "../../src/lib/rbac.js";

export interface FakeUser {
  tenantId: string;
  role: Role;
  /** Set for members of a sandbox workspace; in the past means the sandbox has expired. */
  expiresAt?: Date | null;
}
export const users = new Map<string, FakeUser>();

/** The lookup requireAuth runs on every request (src/middleware/auth.ts). */
const AUTH_LOOKUP = /^SELECT u\.role, t\.expires_at AS "expiresAt"/;

const noDatabase = () => Promise.reject(new Error("no database in unit tests"));

/** Extra queries a test answers: the first entry whose pattern matches the SQL gives the rows. */
export const answers: { match: RegExp; rows: (params: unknown[]) => Record<string, unknown>[] }[] = [];

export const query = vi.fn(async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
  if (AUTH_LOOKUP.test(text)) {
    const user = users.get(params[0] as string);
    if (!user || user.tenantId !== params[1]) return [];
    const expiresAt = user.expiresAt ?? null;
    return [{ role: user.role, expiresAt, expired: expiresAt && expiresAt.getTime() <= Date.now() }];
  }
  const answer = answers.find((a) => a.match.test(text));
  return answer ? answer.rows(params) : noDatabase();
});
export const withTx = vi.fn(noDatabase);
export const pool = { query: noDatabase, connect: noDatabase, end: async () => {} };

/** Puts a user in the fake table and returns an Authorization header carrying its token. */
export function bearer(
  role: Role,
  { sub = `user-${role}`, tenantId = "t1", expiresAt = null as Date | null } = {},
) {
  users.set(sub, { tenantId, role, expiresAt });
  return `Bearer ${signToken({ sub, tenantId, role })}`;
}
