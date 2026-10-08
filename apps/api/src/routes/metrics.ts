import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { query } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { MAX_CSV_BYTES, parseMetricsCsv } from "../lib/csv.js";
import { todayUtc } from "../lib/dates.js";
import { decodeFilename } from "../lib/files.js";
import { generateDemoData } from "../lib/demoData.js";
import { buildPdf, buildXlsx } from "../lib/exporters.js";
import { getInsights, type Insights } from "../lib/insights.js";
import { getDailySeries, getDashboard, importDemo, importRows, listMetrics } from "../lib/metrics.js";
import { bumpDataVersion } from "../lib/redis.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { aiRateLimit } from "../middleware/rateLimit.js";
import { DashboardQuery, ExportQuery, UpdateMetricBody } from "../schemas.js";

export const metricsRouter = Router();
metricsRouter.use(requireAuth);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    file.originalname = decodeFilename(file.originalname);
    if (/\.(csv|tsv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new HttpError(415, "upload a .csv file with date, metric and value columns"));
  },
});

metricsRouter.get("/", requireRole("viewer"), async (req, res) => {
  res.json({ data: await listMetrics(req.user!.tenantId) });
});

metricsRouter.get("/dashboard", requireRole("viewer"), async (req, res) => {
  const q = DashboardQuery.parse(req.query);
  res.json(await getDashboard(req.user!.tenantId, q.days, q.bucket, q.to));
});

metricsRouter.get("/insights", requireRole("viewer"), aiRateLimit, async (req, res) => {
  const q = DashboardQuery.parse(req.query);
  const dashboard = await getDashboard(req.user!.tenantId, q.days, "day", q.to);
  if (dashboard.kpis.length === 0) return res.json({ anomalies: [], summary: "", provider: "none", ms: 0 });
  try {
    res.json(await getInsights(req.user!.tenantId, dashboard));
  } catch (err) {
    throw new HttpError(502, `AI insights unavailable: ${(err as Error).message}`);
  }
});

// Exports embed the AI insights (and are the most expensive request), so they share the AI budget.
metricsRouter.get("/export", requireRole("viewer"), aiRateLimit, async (req, res) => {
  const q = ExportQuery.parse(req.query);
  const tenantId = req.user!.tenantId;
  const dashboard = await getDashboard(tenantId, q.days, q.bucket, q.to);
  const [tenant] = await query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [tenantId]);
  const daily = await getDailySeries(tenantId, dashboard.period.from, dashboard.period.to);

  // The report degrades gracefully: without the AI service it just omits the insights section.
  let insights: Insights | null = null;
  if (dashboard.kpis.length > 0) insights = await getInsights(tenantId, dashboard).catch(() => null);

  const report = { tenantName: tenant.name, generatedAt: new Date(), dashboard, daily, insights };
  const file = q.format === "xlsx" ? await buildXlsx(report) : await buildPdf(report);
  const filename = `opsmind-kpis-${dashboard.period.from}-to-${dashboard.period.to}.${q.format}`;

  await audit({ tenantId, actorId: req.user!.sub, action: "metrics.exported", target: filename });
  res
    .type(q.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf")
    .attachment(filename)
    .send(file);
});

metricsRouter.post("/import", requireRole("member"), csvUpload.single("file"), async (req, res) => {
  if (!req.file) throw new HttpError(400, "file is required (multipart field 'file')");
  const { rows, errors } = parseMetricsCsv(req.file.buffer);
  if (req.user!.sandbox && rows.length + errors.length > config.SANDBOX_MAX_CSV_ROWS) {
    throw new HttpError(413, `a temporary workspace imports at most ${config.SANDBOX_MAX_CSV_ROWS} rows at a time`);
  }
  const report = { errorCount: errors.length, errors: errors.slice(0, 50) };
  if (rows.length === 0) return res.status(400).json({ error: "no valid rows to import", ...report });

  const imported = await importRows(req.user!.tenantId, rows);
  await bumpDataVersion(req.user!.tenantId);
  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "metrics.imported",
    target: req.file.originalname,
    meta: { ...imported, skipped: errors.length },
  });
  res.status(201).json({ imported, ...report });
});

metricsRouter.post("/demo", requireRole("admin"), async (req, res) => {
  const imported = await importDemo(req.user!.tenantId, generateDemoData(todayUtc()));
  await bumpDataVersion(req.user!.tenantId);
  await audit({ tenantId: req.user!.tenantId, actorId: req.user!.sub, action: "metrics.demo_loaded", meta: imported });
  res.status(201).json({ imported });
});

metricsRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const body = UpdateMetricBody.parse(req.body);
  const [metric] = await query(
    `UPDATE metrics
        SET name = COALESCE($3, name), unit = COALESCE($4, unit),
            aggregation = COALESCE($5, aggregation), direction = COALESCE($6, direction),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, key, name, unit, aggregation, direction`,
    [req.params.id, req.user!.tenantId, body.name ?? null, body.unit ?? null, body.aggregation ?? null, body.direction ?? null],
  );
  if (!metric) throw new HttpError(404, "metric not found");
  await bumpDataVersion(req.user!.tenantId);
  await audit({ tenantId: req.user!.tenantId, actorId: req.user!.sub, action: "metric.updated", target: metric.name, meta: body });
  res.json(metric);
});

metricsRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  const [metric] = await query<{ name: string }>(
    "DELETE FROM metrics WHERE id = $1 AND tenant_id = $2 RETURNING name",
    [req.params.id, req.user!.tenantId],
  );
  if (!metric) throw new HttpError(404, "metric not found");
  await bumpDataVersion(req.user!.tenantId);
  await audit({ tenantId: req.user!.tenantId, actorId: req.user!.sub, action: "metric.deleted", target: metric.name });
  res.status(204).end();
});
