import type { RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

export const MAX_UPLOAD_BYTES = config.MAX_UPLOAD_BYTES;

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

/**
 * Resolve the canonical MIME type from the file extension (browsers report .md inconsistently),
 * or null if the type is unsupported.
 */
export function resolveMimeType(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? null;
}

/** Multer decodes multipart filenames as latin1; restore UTF-8 so Cyrillic/Arabic names survive. */
export function decodeFilename(name: string): string {
  return Buffer.from(name, "latin1").toString("utf8");
}

export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;
}

/** "512 KB", "1 MB", "1.5 MB": for limits in error messages. */
export function formatBytes(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return kb < 1024 ? `${kb} KB` : `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/**
 * Multipart middleware for one file in the field "file", kept in memory. Members of a sandbox get the
 * smaller SANDBOX_MAX_FILE_BYTES: multer stops reading at the limit, so an oversized file is refused (413)
 * before it is buffered or parsed. The sandbox limit is read per request, like the other sandbox settings.
 */
export function singleFileUpload(fileFilter: multer.Options["fileFilter"], maxBytes: number): RequestHandler {
  const regular = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 }, fileFilter });
  return (req, res, next) => {
    if (!req.user?.sandbox) return regular.single("file")(req, res, next);
    const limit = Math.min(maxBytes, config.SANDBOX_MAX_FILE_BYTES);
    const sandbox = multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 1 }, fileFilter });
    sandbox.single("file")(req, res, (err?: unknown) =>
      next(
        err instanceof MulterError && err.code === "LIMIT_FILE_SIZE"
          ? new HttpError(413, `a temporary workspace accepts files up to ${formatBytes(limit)}`)
          : err,
      ),
    );
  };
}
