import { Router } from "express";
import { query } from "../lib/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Pagination } from "../schemas.js";

export const auditRouter = Router();

/** Keyset-paginated audit trail; served by audit_tenant_time_idx. */
auditRouter.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { limit, before } = Pagination.parse(req.query);
  const rows = await query<{ createdAt: Date }>(
    `SELECT a.id, a.action, a.target, a.meta, a.created_at AS "createdAt", u.email AS "actorEmail"
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.tenant_id = $1 AND a.created_at < $2
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [req.user!.tenantId, before ?? new Date(), limit],
  );
  res.json({ data: rows, nextBefore: rows.length === limit ? rows.at(-1)!.createdAt : null });
});
