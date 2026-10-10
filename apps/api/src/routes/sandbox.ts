import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { createSandbox, endSandbox } from "../lib/sandbox.js";
import { requireAuth } from "../middleware/auth.js";

export const sandboxRouter = Router();

// Read per request rather than at mount time, so tests can flip the switch without reloading the app.
const requireSandboxEnabled: RequestHandler = (_req, _res, next) =>
  config.ALLOW_SANDBOX ? next() : next(new HttpError(403, "the sandbox is disabled on this deployment"));

// Per client IP (behind a proxy this relies on TRUST_PROXY). In-memory, so per instance; the global
// SANDBOX_MAX_ACTIVE cap in createSandbox() is what holds across serverless instances.
// Only sandboxes actually created count: a visitor who clicks while every slot is taken (503) keeps
// their allowance for when one frees up.
const perIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => config.SANDBOX_RATE_LIMIT,
  skip: () => config.SANDBOX_RATE_LIMIT === 0,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many temporary workspaces from your network, try again later" },
});

/** No auth: creates a temporary workspace and answers with its owner's token. */
sandboxRouter.post("/", requireSandboxEnabled, perIp, async (_req, res) => {
  res.status(201).json(await createSandbox());
});

/**
 * Ends the caller's sandbox now ("Sign out" in a sandbox), which frees its slot for the next visitor. Only
 * its owner may, and only in a sandbox. Not one of the budgeted writes, and open even with the sandbox
 * switched off, so live sandboxes can still be ended.
 */
sandboxRouter.delete("/", requireAuth, async (req, res) => {
  const { tenantId, role, sandbox } = req.user!;
  if (!sandbox || role !== "owner") throw new HttpError(403, "only the owner of a temporary workspace can end it");
  await endSandbox(tenantId);
  res.status(204).end();
});
