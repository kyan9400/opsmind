-- KPI metrics: one row per tracked metric, one point per metric per day.
CREATE TABLE IF NOT EXISTS metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,                      -- slug of the name, stable across imports
  name         text NOT NULL,
  unit         text NOT NULL DEFAULT '',
  -- How daily points roll up into a week/month/period: totals (revenue) vs averages (resolution time).
  aggregation  text NOT NULL DEFAULT 'sum' CHECK (aggregation IN ('sum', 'avg')),
  -- Which direction is good: drives delta colouring and whether an anomaly is a problem.
  direction    text NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS metric_points (
  metric_id  uuid NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        date NOT NULL,
  value      double precision NOT NULL,
  PRIMARY KEY (metric_id, day)
);
-- Dashboard reads are "all metrics for a tenant over a date range".
CREATE INDEX IF NOT EXISTS metric_points_tenant_day_idx ON metric_points (tenant_id, day);
