import { Router } from "express";
import { query, withTx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import {
  decodeFilename,
  MAX_UPLOAD_BYTES,
  resolveMimeType,
  singleFileUpload,
  titleFromFilename,
} from "../lib/files.js";
import { enqueueIngest } from "../lib/queue.js";
import { assertDocumentBudget, reserveSandboxWrite } from "../lib/sandboxLimits.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sandboxWriteGuard } from "../middleware/rateLimit.js";
import { DocumentTitle } from "../schemas.js";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const upload = singleFileUpload((_req, file, cb) => {
  file.originalname = decodeFilename(file.originalname);
  if (resolveMimeType(file.originalname)) cb(null, true);
  else cb(new HttpError(415, "only PDF, TXT and Markdown files are supported"));
}, MAX_UPLOAD_BYTES);

// Never select `content` in list/detail responses: it is the raw file.
const COLUMNS = `id, title, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", status, error,
  chunk_count AS "chunkCount", created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * A document still queued or processing after this long lost its indexing run (a serverless instance
 * stopped mid-way). It is longer than the worker's 3 attempts of up to 120 s each, plus the backoff.
 */
const STUCK_AFTER = "15 minutes";

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

documentsRouter.post("/", requireRole("member"), sandboxWriteGuard, upload, async (req, res) => {
  if (!req.file) throw new HttpError(400, "file is required (multipart field 'file')");
  const { originalname, buffer, size } = req.file;
  const { tenantId, sub, sandbox } = req.user!;
  const title = DocumentTitle.parse(req.body?.title || titleFromFilename(originalname));

  const doc = await withTx(async (tx) => {
    if (sandbox) {
      // Lock first, then count: parallel uploads to one sandbox are checked one after another.
      await reserveSandboxWrite(tx, tenantId);
      await assertDocumentBudget(tx, tenantId, size);
    }
    const {
      rows: [created],
    } = await tx.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [tenantId, title, originalname, resolveMimeType(originalname), size, buffer, sub],
    );
    const meta = { documentId: created.id, sizeBytes: size };
    await audit({ tenantId, actorId: sub, action: "document.uploaded", target: title, meta }, tx);
    return created;
  });
  // After the commit, so the worker (or the inline ingest) finds the row.
  await enqueueIngest(doc.id);
  // 202: accepted, indexing happens asynchronously (the worker, or this process after responding when
  // INGEST_MODE=inline).
  res.status(202).json(doc);
});

documentsRouter.post("/:id/reindex", requireRole("admin"), sandboxWriteGuard, async (req, res) => {
  const { tenantId, sub, sandbox } = req.user!;
  const doc = await withTx(async (tx) => {
    if (sandbox) await reserveSandboxWrite(tx, tenantId);
    // In a sandbox only a failed or stuck document can be re-indexed. Re-indexing a ready (or running)
    // one gives the same chunks for another full extract-and-embed pass, so a reindex loop is refused.
    const {
      rows: [updated],
    } = await tx.query<{ id: string; title: string }>(
      `UPDATE documents SET status = 'queued', error = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND (NOT $3::boolean OR status = 'failed'
               OR (status IN ('queued', 'processing') AND updated_at < now() - $4::interval))
        RETURNING id, title`,
      [req.params.id, tenantId, sandbox, STUCK_AFTER],
    );
    if (!updated) {
      const { rowCount } = await tx.query("SELECT 1 FROM documents WHERE id = $1 AND tenant_id = $2", [
        req.params.id,
        tenantId,
      ]);
      throw rowCount
        ? new HttpError(409, "a temporary workspace can only re-index a document whose indexing failed")
        : new HttpError(404, "document not found");
    }
    await audit({ tenantId, actorId: sub, action: "document.reindexed", target: updated.title }, tx);
    return updated;
  });
  await enqueueIngest(doc.id);
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
