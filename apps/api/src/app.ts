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
import { documentsRouter } from "./routes/documents.js";
import { askRouter } from "./routes/ask.js";
import { metricsRouter } from "./routes/metrics.js";
import { cronRouter } from "./routes/cron.js";
import { sandboxRouter } from "./routes/sandbox.js";
import { registry } from "./lib/apiMetrics.js";
import { httpMetrics, markMount } from "./lib/telemetry.js";

const QUIET_PATHS = new Set(["/metrics", "/health", "/ready"]);

export function createApp() {
  const app = express();
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(helmet());
  // Expose Content-Disposition so the browser can read export filenames on this cross-origin API.
  app.use(cors({ origin: config.CORS_ORIGIN, exposedHeaders: ["Content-Disposition"] }));
  app.use(express.json({ limit: "1mb" }));
  if (config.NODE_ENV !== "test") {
    // Probes and scrapes hit these every few seconds; logging them would bury real traffic.
    app.use(pinoHttp({ autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? "") } }));
  }
  app.use(httpMetrics(registry));

  // Scraped by Prometheus on the internal network; the production proxy blocks it from the internet.
  // Hosts with nothing in front to block it (Vercel) set METRICS_PUBLIC=false, and it answers 404.
  if (config.METRICS_PUBLIC) {
    app.get("/metrics", async (_req, res) => {
      res.type(registry.contentType).send(await registry.metrics());
    });
  }
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "db unavailable" });
    }
  });

  app.use("/api/v1/auth", markMount, authRouter);
  app.use("/api/v1/users", markMount, usersRouter);
  app.use("/api/v1/audit", markMount, auditRouter);
  app.use("/api/v1/documents", markMount, documentsRouter);
  app.use("/api/v1/ask", markMount, askRouter);
  app.use("/api/v1/metrics", markMount, metricsRouter);
  // Answers 403 unless ALLOW_SANDBOX=true.
  app.use("/api/v1/sandbox", markMount, sandboxRouter);
  // Scheduled jobs (Vercel Cron). Without a CRON_SECRET the routes do not exist.
  if (config.CRON_SECRET) app.use("/api/internal/cron", markMount, cronRouter);

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use(errorHandler);
  return app;
}

// Vercel's zero-config Express support serves the default export of this module (dist/app.js, see
// apps/api/vercel.json). server.ts listens with the same instance.
export default createApp();
