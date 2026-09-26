import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: "validation_failed", issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "already exists" });
  req.log?.error(err);
  res.status(500).json({ error: "internal error" });
}
