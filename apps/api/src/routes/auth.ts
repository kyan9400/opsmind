import { randomBytes } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { query, withTx } from "../lib/db.js";
import { hashPassword, signToken, verifyPassword } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import type { Role } from "../lib/rbac.js";
import { requireAuth } from "../middleware/auth.js";
import { LoginBody, RegisterBody } from "../schemas.js";

export const authRouter = Router();

// Brute-force guard for the public demo: credential endpoints only, per client IP.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.AUTH_RATE_LIMIT,
  skip: () => config.AUTH_RATE_LIMIT === 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many attempts, try again in a few minutes" },
});
authRouter.use(["/login", "/register"], credentialLimiter);

// Compared against when the email is unknown, so login costs one bcrypt compare either way and the
// response time does not reveal which accounts exist. Random input, so it never matches; hashed once at
// startup with the same cost as real passwords.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

/**
 * Creates a new tenant and its first user (the owner). A taken email ends in the generic 409
 * "already exists" from the error handler, with no email, tenant or constraint details. Hiding even
 * that needs email verification (answer the same either way, then email the address owner).
 */
authRouter.post("/register", async (req, res) => {
  // The public demo runs on a small free database: visitors use the seeded read-only login instead.
  if (!config.ALLOW_REGISTRATION) {
    throw new HttpError(403, "registration is disabled on this deployment; sign in with the demo account");
  }
  const body = RegisterBody.parse(req.body);
  const passwordHash = await hashPassword(body.password);

  const user = await withTx(async (tx) => {
    const tenant = await tx.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [
      body.tenantName,
    ]);
    const tenantId = tenant.rows[0].id;
    const u = await tx.query<{ id: string }>(
      "INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id",
      [tenantId, body.email, body.name, passwordHash],
    );
    await audit({ tenantId, actorId: u.rows[0].id, action: "tenant.created", target: body.tenantName }, tx);
    return { id: u.rows[0].id, tenantId, role: "owner" as Role };
  });

  res.status(201).json({ token: signToken({ sub: user.id, tenantId: user.tenantId, role: user.role }) });
});

authRouter.post("/login", async (req, res) => {
  const body = LoginBody.parse(req.body);
  const [user] = await query<{ id: string; tenant_id: string; role: Role; password_hash: string }>(
    "SELECT id, tenant_id, role, password_hash FROM users WHERE email = $1",
    [body.email],
  );
  // Same error and the same bcrypt work for unknown email and wrong password to avoid account enumeration.
  const valid = await verifyPassword(body.password, user?.password_hash ?? (await DUMMY_HASH));
  if (!user || !valid) throw new HttpError(401, "invalid credentials");
  await audit({ tenantId: user.tenant_id, actorId: user.id, action: "user.login" });
  res.json({ token: signToken({ sub: user.id, tenantId: user.tenant_id, role: user.role }) });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const [me] = await query(
    // expiresAt: null for a normal workspace; set for a sandbox, which the web app counts down.
    `SELECT u.id, u.email, u.name, u.role, t.id AS "tenantId", t.name AS "tenantName", t.expires_at AS "expiresAt"
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1`,
    [req.user!.sub],
  );
  if (!me) throw new HttpError(404, "user not found");
  res.json(me);
});
