import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { Role } from "./rbac.js";

export interface Principal {
  sub: string;
  tenantId: string;
  role: Role;
  /** Set by requireAuth for members of a temporary sandbox workspace; never part of the token. */
  sandbox?: boolean;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// Sandbox tokens live as long as their workspace (24 h): nobody knows the sandbox owner's password, so
// there is no signing in again.
export const signToken = ({ sub, tenantId, role }: Principal, expiresIn: "8h" | "24h" = "8h") =>
  jwt.sign({ sub, tenantId, role }, config.JWT_SECRET, { expiresIn });
export const verifyToken = (token: string) => jwt.verify(token, config.JWT_SECRET) as Principal;
