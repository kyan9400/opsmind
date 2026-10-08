import { Router } from "express";
import { query } from "../lib/db.js";
import { hashPassword } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { canAssign, type Role } from "../lib/rbac.js";
import { forbidSandbox, requireAuth, requireRole } from "../middleware/auth.js";
import { CreateUserBody, UpdateRoleBody } from "../schemas.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

// Every query is scoped by tenant_id from the token — never from the request body.
usersRouter.get("/", requireRole("viewer"), async (req, res) => {
  const users = await query(
    `SELECT id, email, name, role, created_at AS "createdAt"
       FROM users WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [req.user!.tenantId],
  );
  res.json({ data: users });
});

// A sandbox is one visitor's scratch space: no accounts for other people, no role changes.
usersRouter.post("/", requireRole("admin"), forbidSandbox, async (req, res) => {
  const body = CreateUserBody.parse(req.body);
  if (!canAssign(req.user!.role, body.role)) throw new HttpError(403, `cannot assign role ${body.role}`);

  const [user] = await query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role`,
    [req.user!.tenantId, body.email, body.name, await hashPassword(body.password), body.role],
  );
  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "user.created",
    target: body.email,
    meta: { role: body.role },
  });
  res.status(201).json(user);
});

usersRouter.patch("/:id/role", requireRole("admin"), forbidSandbox, async (req, res) => {
  const { role } = UpdateRoleBody.parse(req.body);
  const [target] = await query<{ role: Role; email: string }>(
    "SELECT role, email FROM users WHERE id = $1 AND tenant_id = $2",
    [req.params.id, req.user!.tenantId],
  );
  if (!target) throw new HttpError(404, "user not found");
  if (!canAssign(req.user!.role, target.role) || !canAssign(req.user!.role, role)) {
    throw new HttpError(403, "insufficient privileges for this role change");
  }

  await query("UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3", [
    role,
    req.params.id,
    req.user!.tenantId,
  ]);
  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "user.role_changed",
    target: target.email,
    meta: { from: target.role, to: role },
  });
  res.json({ id: req.params.id, role });
});
