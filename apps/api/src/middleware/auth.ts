import type { NextFunction, Request, Response } from "express";
import { verifyToken, type Principal } from "../lib/auth.js";
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

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return next(new HttpError(401, "missing bearer token"));
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    next(new HttpError(401, "invalid or expired token"));
  }
}

export const requireRole = (role: Role) => (req: Request, _res: Response, next: NextFunction) =>
  req.user && hasRole(req.user.role, role) ? next() : next(new HttpError(403, `requires ${role} role`));
