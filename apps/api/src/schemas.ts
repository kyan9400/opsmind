import { z } from "zod";
import { ROLES } from "./lib/rbac.js";

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8).max(128);

export const RegisterBody = z.object({
  tenantName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(80),
  email,
  password,
});

export const LoginBody = z.object({ email, password: z.string().min(1) });

export const CreateUserBody = z.object({
  name: z.string().trim().min(1).max(80),
  email,
  password,
  role: z.enum(ROLES).default("member"),
});

export const UpdateRoleBody = z.object({ role: z.enum(ROLES) });

export const DocumentTitle = z.string().trim().min(1).max(200);

export const AskBody = z.object({
  question: z.string().trim().min(1).max(500),
  topK: z.coerce.number().int().min(1).max(10).default(5),
});

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.date().optional(),
});
