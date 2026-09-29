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
