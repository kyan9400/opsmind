import { addDays, eachDay } from "./dates.js";

export interface DemoMetric {
  name: string;
  unit: string;
  aggregation: "sum" | "avg";
  direction: "up" | "down";
  points: { day: string; value: number }[];
}

/** Small seeded PRNG (mulberry32) so demo data and its anomalies are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  name: string;
  unit: string;
  aggregation: "sum" | "avg";
  direction: "up" | "down";
  base: number;
  trendPerDay: number; // fractional growth per day
  weekend: number; // multiplier on Sat/Sun
  noise: number; // +- fraction
  decimals: number;
  anomalies: { daysAgo: number; factor: number }[];
}

const SPECS: Spec[] = [
  { name: "Revenue", unit: "$", aggregation: "sum", direction: "up", base: 12_000, trendPerDay: 0.0015, weekend: 0.55, noise: 0.06, decimals: 0, anomalies: [{ daysAgo: 12, factor: 0.55 }] },
  { name: "Orders", unit: "", aggregation: "sum", direction: "up", base: 180, trendPerDay: 0.0012, weekend: 0.6, noise: 0.07, decimals: 0, anomalies: [{ daysAgo: 12, factor: 0.6 }] },
  { name: "New customers", unit: "", aggregation: "sum", direction: "up", base: 42, trendPerDay: 0.001, weekend: 0.5, noise: 0.1, decimals: 0, anomalies: [{ daysAgo: 45, factor: 2.4 }] },
  { name: "Support tickets", unit: "", aggregation: "sum", direction: "down", base: 64, trendPerDay: -0.0008, weekend: 0.4, noise: 0.08, decimals: 0, anomalies: [{ daysAgo: 5, factor: 2.6 }] },
  { name: "Avg resolution time", unit: "h", aggregation: "avg", direction: "down", base: 6.5, trendPerDay: -0.001, weekend: 1.15, noise: 0.05, decimals: 1, anomalies: [{ daysAgo: 20, factor: 2.1 }] },
  { name: "Customer satisfaction", unit: "%", aggregation: "avg", direction: "up", base: 91, trendPerDay: 0.00005, weekend: 1.0, noise: 0.01, decimals: 1, anomalies: [{ daysAgo: 5, factor: 0.86 }] },
];

/**
 * 180 days of plausible operational data ending on `to`: growth trend, weekly seasonality,
 * seeded noise, and a handful of injected incidents for the anomaly detector to find.
 */
export function generateDemoData(to: string, days = 180, seed = 42): DemoMetric[] {
  const from = addDays(to, -(days - 1));
  const all = eachDay(from, to);
  return SPECS.map((spec, si) => {
    const rand = rng(seed + si * 7919);
    const incidents = new Map(spec.anomalies.map((a) => [addDays(to, -a.daysAgo), a.factor]));
    return {
      name: spec.name,
      unit: spec.unit,
      aggregation: spec.aggregation,
      direction: spec.direction,
      points: all.map((day, i) => {
        const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
        const seasonal = weekday === 0 || weekday === 6 ? spec.weekend : 1;
        const noise = 1 + (rand() * 2 - 1) * spec.noise;
        let value = spec.base * (1 + spec.trendPerDay * i) * seasonal * noise * (incidents.get(day) ?? 1);
        if (spec.unit === "%") value = Math.min(value, 100);
        const f = 10 ** spec.decimals;
        return { day, value: Math.round(value * f) / f };
      }),
    };
  });
}
