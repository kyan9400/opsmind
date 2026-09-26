import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { Role } from "./rbac.js";

export interface Principal {
  sub: string;
  tenantId: string;
  role: Role;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export const signToken = (p: Principal) => jwt.sign(p, config.JWT_SECRET, { expiresIn: "8h" });
export const verifyToken = (token: string) => jwt.verify(token, config.JWT_SECRET) as Principal;
