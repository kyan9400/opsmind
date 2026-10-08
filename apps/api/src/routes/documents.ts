import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { query } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { decodeFilename, MAX_UPLOAD_BYTES, resolveMimeType, titleFromFilename } from "../lib/files.js";
import { enqueueIngest } from "../lib/queue.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { DocumentTitle } from "../schemas.js";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    file.originalname = decodeFilename(file.originalname);
    if (resolveMimeType(file.originalname)) cb(null, true);
    else cb(new HttpError(415, "only PDF, TXT and Markdown files are supported"));
  },
});

// Never select `content` in list/detail responses: it is the raw file.
const COLUMNS = `id, title, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", status, error,
  chunk_count AS "chunkCount", created_at AS "createdAt", updated_at AS "updatedAt"`;

documentsRouter.get("/", requireRole("viewer"), async (req, res) => {
  const docs = await query(
    `SELECT ${COLUMNS} FROM documents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.user!.tenantId],
  );
  res.json({ data: docs });
});

documentsRouter.get("/:id", requireRole("viewer"), async (req, res) => {
  const [doc] = await query(`SELECT ${COLUMNS} FROM documents WHERE id = $1 AND tenant_id = $2`, [
    req.params.id,
    req.user!.tenantId,
  ]);
  if (!doc) throw new HttpError(404, "document not found");
  res.json(doc);
});

documentsRouter.post("/", requireRole("member"), upload.single("file"), async (req, res) => {
  if (!req.file) throw new HttpError(400, "file is required (multipart field 'file')");
  const { originalname, buffer, size } = req.file;
  const title = DocumentTitle.parse(req.body?.title || titleFromFilename(originalname));
  if (req.user!.sandbox) {
    const [{ n }] = await query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1", [
      req.user!.tenantId,
    ]);
    if (n >= config.SANDBOX_MAX_DOCUMENTS) {
      throw new HttpError(403, `a temporary workspace holds at most ${config.SANDBOX_MAX_DOCUMENTS} documents`);
    }
  }

  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [req.user!.tenantId, title, originalname, resolveMimeType(originalname), size, buffer, req.user!.sub],
  );
  await enqueueIngest(doc.id);
  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "document.uploaded",
    target: title,
    meta: { documentId: doc.id, sizeBytes: size },
  });
  // 202: accepted, indexing happens asynchronously (the worker, or this process after responding when
  // INGEST_MODE=inline).
  res.status(202).json(doc);
});

documentsRouter.post("/:id/reindex", requireRole("admin"), async (req, res) => {
  const [doc] = await query<{ id: string; title: string }>(
    `UPDATE documents SET status = 'queued', error = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING id, title`,
    [req.params.id, req.user!.tenantId],
  );
  if (!doc) throw new HttpError(404, "document not found");
  await enqueueIngest(doc.id);
  await audit({ tenantId: req.user!.tenantId, actorId: req.user!.sub, action: "document.reindexed", target: doc.title });
  res.status(202).json({ id: doc.id, status: "queued" });
});

documentsRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  const [doc] = await query<{ title: string }>(
    "DELETE FROM documents WHERE id = $1 AND tenant_id = $2 RETURNING title",
    [req.params.id, req.user!.tenantId],
  );
  if (!doc) throw new HttpError(404, "document not found");
  await audit({ tenantId: req.user!.tenantId, actorId: req.user!.sub, action: "document.deleted", target: doc.title });
  res.status(204).end();
});
