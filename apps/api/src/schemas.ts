import { z } from "zod";
import { ROLES } from "./lib/rbac.js";

const email = z.string().trim().toLowerCase().email();
// .invalid never resolves (RFC 2606), so no real person has such an address; the demo seed uses it for
// its hidden owner account, and nobody should be able to create a look-alike.
const newEmail = email.refine((e) => !e.endsWith(".invalid"), "this email domain is reserved");
const password = z.string().min(8).max(128);

export const RegisterBody = z.object({
  tenantName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(80),
  email: newEmail,
  password,
});

export const LoginBody = z.object({ email, password: z.string().min(1) });

export const CreateUserBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: newEmail,
  password,
  role: z.enum(ROLES).default("member"),
});

export const UpdateRoleBody = z.object({ role: z.enum(ROLES) });

export const DocumentTitle = z.string().trim().min(1).max(200);

/** Limits of the AI service's /v1/ask history, which answers 422 (no truncation) to anything longer. */
export const ASK_HISTORY_TURNS = 4;
export const ASK_HISTORY_CHARS = 2000;

const HistoryTurn = z.object({
  question: z.string().trim().max(ASK_HISTORY_CHARS),
  answer: z.string().trim().max(ASK_HISTORY_CHARS),
});

export const AskBody = z.object({
  question: z.string().trim().min(1).max(500),
  topK: z.coerce.number().int().min(1).max(10).default(5),
  /** Earlier turns of the conversation, oldest first, so follow-ups like "and for express?" resolve. */
  history: z
    .array(HistoryTurn)
    .max(ASK_HISTORY_TURNS)
    .default([])
    // A turn without a question gives the AI service nothing to rewrite the follow-up against.
    .transform((turns) => turns.filter((t) => t.question !== "")),
});

const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    // Month 13 or day 32 give an Invalid Date, whose toISOString() would throw (a 500, not a 400).
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) && s >= "1970-01-01";
  }, "not a real date");

export const DashboardQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
  bucket: z.enum(["day", "week", "month"]).default("day"),
  /** Last day of the period (inclusive); defaults to today (UTC). */
  to: IsoDay.optional(),
});

export const ExportQuery = DashboardQuery.extend({ format: z.enum(["xlsx", "pdf"]) });

export const UpdateMetricBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    unit: z.string().trim().max(12),
    aggregation: z.enum(["sum", "avg"]),
    direction: z.enum(["up", "down"]),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.date().optional(),
});
