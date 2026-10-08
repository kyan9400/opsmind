import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

/**
 * Budget for endpoints that call the AI service, so nobody can burn the LLM quota through the public
 * demo login. Ask, insights and report exports share it. Mount it after requireAuth.
 *
 * Every demo visitor signs in as the same viewer, so a budget per user alone would let one visitor (or
 * a busy minute: the analytics page loads insights on every view) lock all of them out. The budget is
 * per user and client IP instead, with an account-wide ceiling of USER_CEILING times that, which caps
 * what one account can pull through many addresses. Behind a proxy this relies on TRUST_PROXY;
 * without it every client has the proxy's IP and the budget is simply per user.
 *
 * The in-memory stores are per API replica (N replicas allow up to N times the limits). That is
 * enough for an abuse brake; a shared store (Redis) would make it exact.
 */
const USER_CEILING = 10;
const disabled = () => config.AI_RATE_LIMIT === 0;

const perVisitor = rateLimit({
  windowMs: 60 * 1000,
  limit: config.AI_RATE_LIMIT,
  skip: disabled,
  keyGenerator: (req) => `${req.user!.sub}:${req.ip}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many AI requests, try again in a minute" },
});

const perUser = rateLimit({
  windowMs: 60 * 1000,
  limit: config.AI_RATE_LIMIT * USER_CEILING,
  skip: disabled,
  keyGenerator: (req) => req.user!.sub,
  // No headers of its own: they would overwrite the visitor's budget, which is what a client can act on.
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: "too many AI requests on this account, try again in a minute" },
});

// Visitor budget first, so requests it already refused do not use up the account-wide ceiling.
export const aiRateLimit: RequestHandler = (req, res, next) =>
  perVisitor(req, res, (err?: unknown) => (err ? next(err) : perUser(req, res, next)));

/**
 * Uploads, re-indexes, CSV imports and demo loads by sandbox members: SANDBOX_WRITE_RATE_LIMIT per
 * sandbox per hour. Each of them runs extraction and embedding on the host's small CPU quota, or writes
 * rows into the free database, and the sandbox owner is an anonymous visitor. In memory, so per
 * instance; reserveSandboxWrite() repeats the count in the database inside the write's transaction.
 * Mount it after requireAuth and before any body parsing, so a refused request is never read.
 */
const sandboxWrites = rateLimit({
  windowMs: 60 * 60 * 1000,
  // Read per request, so tests can change it without reloading the app.
  limit: () => config.SANDBOX_WRITE_RATE_LIMIT,
  skip: (req) => !req.user?.sandbox || config.SANDBOX_WRITE_RATE_LIMIT === 0,
  keyGenerator: (req) => req.user!.tenantId,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many uploads and imports in this temporary workspace, try again later" },
});

/** Guard for every write a sandbox member can make. */
export const sandboxWriteGuard: RequestHandler = sandboxWrites;
