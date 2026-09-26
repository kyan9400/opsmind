import { aiPost } from "./aiClient.js";
import { insightsCache } from "./apiMetrics.js";
import { addDays } from "./dates.js";
import { getDailySeries, type Dashboard } from "./metrics.js";
import { cacheGet, cacheSet, dataVersion } from "./redis.js";

export interface Anomaly {
  metricId: string;
  metric: string;
  unit: string;
  day: string;
  value: number;
  expected: number;
  deviationPct: number | null;
  z: number;
  severity: "medium" | "high";
  kind: "spike" | "drop";
  /** The move is in the bad direction for this metric (e.g. revenue down, tickets up). */
  bad: boolean;
}

export interface Insights {
  anomalies: Anomaly[];
  summary: string;
  provider: string;
  ms: number;
}

interface AiInsights {
  anomalies: {
    metric_id: string;
    metric: string;
    unit: string;
    day: string;
    value: number;
    expected: number;
    deviation_pct: number | null;
    z: number;
    severity: "medium" | "high";
    kind: "spike" | "drop";
    bad: boolean;
  }[];
  summary: string;
  provider: string;
  ms: number;
  detail?: string;
}

// The detector compares each day with the same weekday over the previous 8 weeks.
const LOOKBACK_DAYS = 56;
const TTL_SECONDS = 600;

/** Anomalies + narrative for a dashboard view. Cached per tenant, period and data version. */
export async function getInsights(tenantId: string, dashboard: Dashboard): Promise<Insights> {
  const { from, to } = dashboard.period;
  const key = `insights:${tenantId}:${from}:${to}:v${await dataVersion(tenantId)}`;
  const cached = await cacheGet<Insights>(key);
  insightsCache.inc({ result: cached ? "hit" : "miss" });
  if (cached) return cached;

  const daily = await getDailySeries(tenantId, addDays(from, -LOOKBACK_DAYS), to);
  const { status, data } = await aiPost<AiInsights>("/v1/insights", {
    start: from,
    end: to,
    metrics: dashboard.kpis.map((k) => ({
      id: k.id,
      name: k.name,
      unit: k.unit,
      direction: k.direction,
      points: daily.get(k.id) ?? [],
    })),
    kpis: dashboard.kpis.map((k) => ({
      name: k.name,
      unit: k.unit,
      direction: k.direction,
      current: k.current,
      previous: k.previous,
      delta_pct: k.deltaPct,
    })),
  });
  if (status !== 200) throw new Error(data.detail ?? `ai service responded ${status}`);

  const insights: Insights = {
    summary: data.summary,
    provider: data.provider,
    ms: data.ms,
    anomalies: data.anomalies.map((a) => ({
      metricId: a.metric_id,
      metric: a.metric,
      unit: a.unit,
      day: a.day,
      value: a.value,
      expected: a.expected,
      deviationPct: a.deviation_pct,
      z: a.z,
      severity: a.severity,
      kind: a.kind,
      bad: a.bad,
    })),
  };
  await cacheSet(key, insights, TTL_SECONDS);
  return insights;
}
