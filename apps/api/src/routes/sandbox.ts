import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { createSandbox } from "../lib/sandbox.js";

export const sandboxRouter = Router();

// Read per request rather than at mount time, so tests can flip the switch without reloading the app.
const requireSandboxEnabled: RequestHandler = (_req, _res, next) =>
  config.ALLOW_SANDBOX ? next() : next(new HttpError(403, "the sandbox is disabled on this deployment"));

// Per client IP (behind a proxy this relies on TRUST_PROXY). In-memory, so per instance; the global
// SANDBOX_MAX_ACTIVE cap in createSandbox() is what holds across serverless instances.
const perIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => config.SANDBOX_RATE_LIMIT,
  skip: () => config.SANDBOX_RATE_LIMIT === 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many temporary workspaces from your network, try again later" },
});

/** No auth: creates a temporary workspace and answers with its owner's token. */
sandboxRouter.post("/", requireSandboxEnabled, perIp, async (_req, res) => {
  res.status(201).json(await createSandbox());
});
