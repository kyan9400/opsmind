export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
