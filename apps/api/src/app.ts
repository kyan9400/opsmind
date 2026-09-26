import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { pool } from "./lib/db.js";
import { errorHandler } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { auditRouter } from "./routes/audit.js";

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));
  if (config.NODE_ENV !== "test") app.use(pinoHttp());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "db unavailable" });
    }
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/audit", auditRouter);

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use(errorHandler);
  return app;
}
