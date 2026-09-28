import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: "validation_failed", issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof MulterError) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message });
  }
  const code = (err as { code?: string }).code;
  if (code === "23505") return res.status(409).json({ error: "already exists" });
  if (code === "22P02") return res.status(404).json({ error: "not found" }); // malformed uuid in path
  req.log?.error(err);
  res.status(500).json({ error: "internal error" });
}
