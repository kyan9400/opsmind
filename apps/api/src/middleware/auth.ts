import type { NextFunction, Request, Response } from "express";
import { verifyToken, type Principal } from "../lib/auth.js";
import { query } from "../lib/db.js";
import { hasRole, type Role } from "../lib/rbac.js";
import { HttpError } from "../lib/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Principal;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return next(new HttpError(401, "missing bearer token"));
  let claims: Principal;
  try {
    claims = verifyToken(header.slice(7));
  } catch {
    return next(new HttpError(401, "invalid or expired token"));
  }
  // The token only proves identity. The role is re-read on every request (one primary-key lookup) so a
  // demotion or removal applies immediately instead of when the 8 h token expires. The same lookup ends a
  // sandbox at its expiry, before the daily cleanup has deleted it.
  const [user] = await query<{ role: Role; expiresAt: Date | null; expired: boolean | null }>(
    `SELECT u.role, t.expires_at AS "expiresAt", t.expires_at <= now() AS expired
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [claims.sub, claims.tenantId],
  );
  if (!user) return next(new HttpError(401, "account no longer exists"));
  if (user.expired) return next(new HttpError(401, "sandbox expired"));
  req.user = { sub: claims.sub, tenantId: claims.tenantId, role: user.role, sandbox: user.expiresAt !== null };
  next();
}

/** For actions a temporary sandbox must not take (inviting people, changing roles). */
export const forbidSandbox = (req: Request, _res: Response, next: NextFunction) =>
  req.user?.sandbox ? next(new HttpError(403, "not available in a temporary sandbox workspace")) : next();

export const requireRole = (role: Role) => (req: Request, _res: Response, next: NextFunction) =>
  req.user && hasRole(req.user.role, role) ? next() : next(new HttpError(403, `requires ${role} role`));
