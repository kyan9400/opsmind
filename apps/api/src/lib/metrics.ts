import type pg from "pg";
import { query, withTx } from "./db.js";
import { metricKey, type MetricRow } from "./csv.js";
import { periodsFor, type Period } from "./dates.js";
import { HttpError } from "./errors.js";

/** Matches the AI service's limit on series per insights request. */
export const MAX_METRICS_PER_TENANT = 100;

export type Aggregation = "sum" | "avg";
export type Direction = "up" | "down";
export type Bucket = "day" | "week" | "month";

export interface MetricDef {
  id: string;
  key: string;
  name: string;
  unit: string;
  aggregation: Aggregation;
  direction: Direction;
}

export interface SeriesPoint {
  bucket: string;
  value: number;
  /** The bucket extends outside the selected period, so its value covers only part of it. */
  partial: boolean;
}

export interface Kpi extends MetricDef {
  current: number | null;
  previous: number | null;
  deltaPct: number | null;
  series: SeriesPoint[];
}

export interface Dashboard {
  period: Period;
  previousPeriod: Period;
  bucket: Bucket;
  kpis: Kpi[];
}

const DEF_COLUMNS = "m.id, m.key, m.name, m.unit, m.aggregation, m.direction";

export const listMetrics = (tenantId: string) =>
  query<MetricDef>(`SELECT ${DEF_COLUMNS} FROM metrics m WHERE m.tenant_id = $1 ORDER BY m.created_at, m.name`, [
    tenantId,
  ]);

const deltaPct = (current: number | null, previous: number | null) =>
  current === null || previous === null || previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;

function bucketEnd(start: string, bucket: Bucket): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (bucket === "week") d.setUTCDate(d.getUTCDate() + 6);
  else if (bucket === "month") d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** KPI totals for the period vs the previous period, plus a bucketed series per metric. */
export async function getDashboard(tenantId: string, days: number, bucket: Bucket, to?: string): Promise<Dashboard> {
  const { current, previous } = periodsFor(days, to);

  // One pass over both periods; FILTER splits them. Sums roll up as totals, averages as means.
  const totals = await query<MetricDef & { current: number | null; previous: number | null }>(
    `SELECT ${DEF_COLUMNS},
            CASE m.aggregation WHEN 'sum' THEN SUM(p.value) FILTER (WHERE p.day >= $2)
                               ELSE AVG(p.value) FILTER (WHERE p.day >= $2) END AS current,
            CASE m.aggregation WHEN 'sum' THEN SUM(p.value) FILTER (WHERE p.day < $2)
                               ELSE AVG(p.value) FILTER (WHERE p.day < $2) END AS previous
       FROM metrics m
       LEFT JOIN metric_points p ON p.metric_id = m.id AND p.day BETWEEN $3 AND $4
      WHERE m.tenant_id = $1
      GROUP BY m.id
      ORDER BY m.created_at, m.name`,
    [tenantId, current.from, previous.from, current.to],
  );

  const series = await query<{ metric_id: string; bucket: string; value: number }>(
    `SELECT p.metric_id,
            to_char(date_trunc($4, p.day::timestamp), 'YYYY-MM-DD') AS bucket,
            CASE m.aggregation WHEN 'sum' THEN SUM(p.value) ELSE AVG(p.value) END AS value
       FROM metric_points p
       JOIN metrics m ON m.id = p.metric_id
      WHERE p.tenant_id = $1 AND p.day BETWEEN $2 AND $3
      GROUP BY p.metric_id, m.aggregation, 2
      ORDER BY 2`,
    [tenantId, current.from, current.to, bucket],
  );

  const byMetric = new Map<string, SeriesPoint[]>();
  for (const s of series) {
    const list = byMetric.get(s.metric_id) ?? [];
    list.push({
      bucket: s.bucket,
      value: s.value,
      partial: s.bucket < current.from || bucketEnd(s.bucket, bucket) > current.to,
    });
    byMetric.set(s.metric_id, list);
  }

  return {
    period: current,
    previousPeriod: previous,
    bucket,
    kpis: totals.map((t) => ({
      ...t,
      deltaPct: deltaPct(t.current, t.previous),
      series: byMetric.get(t.id) ?? [],
    })),
  };
}

/** Raw daily points for [from, to], grouped per metric (input for anomaly detection and exports). */
export async function getDailySeries(tenantId: string, from: string, to: string) {
  const rows = await query<{ metric_id: string; day: string; value: number }>(
    `SELECT metric_id, to_char(day, 'YYYY-MM-DD') AS day, value
       FROM metric_points
      WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
      ORDER BY day`,
    [tenantId, from, to],
  );
  const out = new Map<string, { day: string; value: number }[]>();
  for (const r of rows) {
    const list = out.get(r.metric_id) ?? [];
    list.push({ day: r.day, value: r.value });
    out.set(r.metric_id, list);
  }
  return out;
}

interface MetricUpsert {
  key: string;
  name: string;
  unit?: string;
  aggregation?: Aggregation;
  direction?: Direction;
}

/**
 * Insert missing metrics and return key -> id. With `overwriteSettings`, existing metrics also take
 * the given name/unit/aggregation/direction (demo data); CSV imports leave admin settings alone.
 */
async function upsertMetrics(tx: pg.PoolClient, tenantId: string, defs: MetricUpsert[], overwriteSettings: boolean) {
  // Cap distinct metrics per tenant. Every view is O(metrics x days), and the AI service accepts
  // at most 100 series, so an unbounded import could stall exports for all tenants.
  // Locking the tenant row serialises concurrent imports so two can't both squeeze under the cap.
  await tx.query("SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  const {
    rows: [{ n }],
  } = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM metrics WHERE tenant_id = $1 AND NOT (key = ANY($2::text[]))",
    [tenantId, defs.map((d) => d.key)],
  );
  if (n + defs.length > MAX_METRICS_PER_TENANT) {
    throw new HttpError(
      422,
      `too many metrics: a workspace can track up to ${MAX_METRICS_PER_TENANT} (this import would make ${n + defs.length})`,
    );
  }

  const res = await tx.query<{ id: string; key: string }>(
    `INSERT INTO metrics (tenant_id, key, name, unit, aggregation, direction)
     SELECT $1, t.key, t.name, t.unit, t.aggregation, t.direction
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS t(key, name, unit, aggregation, direction)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       updated_at  = now(),
       name        = CASE WHEN $7 THEN EXCLUDED.name        ELSE metrics.name        END,
       unit        = CASE WHEN $7 THEN EXCLUDED.unit        ELSE metrics.unit        END,
       aggregation = CASE WHEN $7 THEN EXCLUDED.aggregation ELSE metrics.aggregation END,
       direction   = CASE WHEN $7 THEN EXCLUDED.direction   ELSE metrics.direction   END
     RETURNING id, key`,
    [
      tenantId,
      defs.map((d) => d.key),
      defs.map((d) => d.name),
      defs.map((d) => d.unit ?? ""),
      defs.map((d) => d.aggregation ?? "sum"),
      defs.map((d) => d.direction ?? "up"),
      overwriteSettings,
    ],
  );
  return new Map(res.rows.map((r) => [r.key, r.id]));
}

const POINT_BATCH = 10_000;

async function upsertPoints(tx: pg.PoolClient, tenantId: string, points: { metricId: string; day: string; value: number }[]) {
  // Bulk upsert via unnest: one round trip per 10k rows instead of one per row.
  for (let i = 0; i < points.length; i += POINT_BATCH) {
    const batch = points.slice(i, i + POINT_BATCH);
    await tx.query(
      `INSERT INTO metric_points (metric_id, tenant_id, day, value)
       SELECT t.metric_id, $1, t.day, t.value
         FROM unnest($2::uuid[], $3::date[], $4::float8[]) AS t(metric_id, day, value)
       ON CONFLICT (metric_id, day) DO UPDATE SET value = EXCLUDED.value`,
      [tenantId, batch.map((p) => p.metricId), batch.map((p) => p.day), batch.map((p) => p.value)],
    );
  }
}

/** Import parsed CSV rows. Duplicate (metric, day) rows: the last one in the file wins. */
export async function importRows(tenantId: string, rows: MetricRow[]) {
  // De-duplicate in memory first: Postgres rejects an upsert that touches the same row twice.
  const names = new Map<string, string>(); // key -> first-seen display name
  const points = new Map<string, { key: string; day: string; value: number }>();
  for (const r of rows) {
    const key = metricKey(r.metric);
    if (!names.has(key)) names.set(key, r.metric);
    points.set(`${key}|${r.day}`, { key, day: r.day, value: r.value });
  }

  return withTx(async (tx) => {
    const ids = await upsertMetrics(
      tx,
      tenantId,
      [...names].map(([key, name]) => ({ key, name })),
      false,
    );
    await upsertPoints(
      tx,
      tenantId,
      [...points.values()].map((p) => ({ metricId: ids.get(p.key)!, day: p.day, value: p.value })),
    );
    return { metrics: names.size, points: points.size };
  });
}

export async function importDemo(
  tenantId: string,
  metrics: { name: string; unit: string; aggregation: Aggregation; direction: Direction; points: { day: string; value: number }[] }[],
) {
  return withTx(async (tx) => {
    const ids = await upsertMetrics(
      tx,
      tenantId,
      metrics.map((m) => ({ key: metricKey(m.name), ...m })),
      true,
    );
    const points = metrics.flatMap((m) =>
      m.points.map((p) => ({ metricId: ids.get(metricKey(m.name))!, day: p.day, value: p.value })),
    );
    await upsertPoints(tx, tenantId, points);
    return { metrics: metrics.length, points: points.length };
  });
}
