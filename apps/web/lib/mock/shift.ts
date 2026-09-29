import type { Bucket, DashboardData, InsightsData } from "../api";

/**
 * Moves recorded dates forward so the latest recorded day is today: the analytics page always asks for
 * "the last N days", and a recording from last month would otherwise show an empty or stale period.
 * Only dates move; every value stays exactly as recorded. Week and month buckets move by whole weeks
 * and months, so they still start on a Monday / the 1st and never collide.
 */

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => toDay(parse(day) + n * DAY_MS);
const monday = (day: string) => parse(day) - ((new Date(parse(day)).getUTCDay() + 6) % 7) * DAY_MS;
const addMonths = (day: string, n: number) => {
  const d = new Date(parse(day));
  return toDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
};

/** Same rule as the API (lib/metrics.ts): a bucket is partial when it sticks out of the period. */
function bucketEnd(start: string, bucket: Bucket): string {
  const d = new Date(parse(start));
  if (bucket === "week") d.setUTCDate(d.getUTCDate() + 6);
  else if (bucket === "month") d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return toDay(d.getTime());
}

/** "Sep 14", as the AI service writes days into the insights summary (services/ai/app/insights.py). */
const summaryDay = (day: string) => {
  const d = new Date(parse(day));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

export type Shifter = ReturnType<typeof createShifter>;

export function createShifter(recordedDay: string, today: string) {
  const days = Math.round((parse(today) - parse(recordedDay)) / DAY_MS);
  const weeks = Math.round((monday(today) - monday(recordedDay)) / DAY_MS);
  const [ry, rm] = recordedDay.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  const months = (ty - ry) * 12 + (tm - rm);

  const day = (d: string) => addDays(d, days);
  const bucket = (d: string, b: Bucket) => (b === "day" ? day(d) : b === "week" ? addDays(d, weeks) : addMonths(d, months));

  return {
    days,
    day,
    /** ISO timestamps (createdAt, updatedAt). */
    time: (ts: string) => new Date(Date.parse(ts) + days * DAY_MS).toISOString(),

    dashboard(d: DashboardData): DashboardData {
      const period = { from: day(d.period.from), to: day(d.period.to) };
      return {
        ...d,
        period,
        previousPeriod: { from: day(d.previousPeriod.from), to: day(d.previousPeriod.to) },
        kpis: d.kpis.map((k) => ({
          ...k,
          series: k.series.map((s) => {
            const start = bucket(s.bucket, d.bucket);
            return { ...s, bucket: start, partial: start < period.from || bucketEnd(start, d.bucket) > period.to };
          }),
        })),
      };
    },

    insights(i: InsightsData): InsightsData {
      // The summary names anomaly days in prose ("Revenue on Sep 14 was ..."); move exactly those.
      const names = new Map(i.anomalies.map((a) => [summaryDay(a.day), summaryDay(day(a.day))]));
      return {
        ...i,
        anomalies: i.anomalies.map((a) => ({ ...a, day: day(a.day) })),
        summary: days === 0 ? i.summary : i.summary.replace(/\b[A-Z][a-z]{2} \d{1,2}\b/g, (m) => names.get(m) ?? m),
      };
    },
  };
}

export const todayUtc = () => toDay(Date.now());
