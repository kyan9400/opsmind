"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LineChart, type ChartMarker } from "@/components/LineChart";
import {
  api,
  ApiError,
  atLeast,
  download,
  type Anomaly,
  type Bucket,
  type DashboardData,
  type ImportResult,
  type InsightsData,
  type Kpi,
  type Me,
} from "@/lib/api";
import { formatDay, formatDeltaPct, formatValue } from "@/lib/format";

const RANGES = [7, 30, 90, 180] as const;
const BUCKETS: { value: Bucket; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const card = "rounded-xl border border-[var(--viz-border)] bg-[var(--viz-surface)]";
const button =
  "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

function isGood(k: Kpi): boolean | null {
  if (k.deltaPct === null || k.deltaPct === 0) return null;
  return k.direction === "up" ? k.deltaPct > 0 : k.deltaPct < 0;
}

function Delta({ kpi, days }: { kpi: Kpi; days: number }) {
  const good = isGood(kpi);
  const arrow = kpi.deltaPct === null || kpi.deltaPct === 0 ? "" : kpi.deltaPct > 0 ? "▲ " : "▼ ";
  const color = good === null ? "var(--viz-ink-2)" : good ? "var(--viz-good-text)" : "var(--viz-critical-text)";
  return (
    <p className="text-sm" style={{ color }}>
      {arrow}
      {formatDeltaPct(kpi.deltaPct)}
      <span style={{ color: "var(--viz-ink-2)" }}> vs previous {days} days</span>
    </p>
  );
}

function AnomalyRow({ a }: { a: Anomaly }) {
  const where = a.kind === "spike" ? "above" : "below";
  return (
    <li>
      <a href={`#metric-${a.metricId}`} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900">
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-white"
          style={{ background: a.bad ? "var(--viz-critical)" : "var(--viz-good)" }}
        >
          {a.kind === "spike" ? "▲" : "▼"}
        </span>
        <span className="text-sm">
          <span className="font-medium" style={{ color: a.bad ? "var(--viz-critical-text)" : "var(--viz-good-text)" }}>
            {a.bad ? "Needs attention" : "Positive"}
          </span>
          <span style={{ color: "var(--viz-ink)" }}>
            {" "}
            · {a.metric} on {formatDay(a.day)}: {formatValue(a.value, a.unit)}
          </span>
          <span style={{ color: "var(--viz-ink-2)" }}>
            {a.deviationPct !== null && ` — ${Math.abs(Math.round(a.deviationPct))}% ${where} expected (${formatValue(a.expected, a.unit)})`}
          </span>
        </span>
      </a>
    </li>
  );
}

function DataTable({ kpi, bucket }: { kpi: Kpi; bucket: Bucket }) {
  return (
    <div className="max-h-56 overflow-y-auto">
      <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
        <caption className="sr-only">{kpi.name} by {bucket}</caption>
        <thead className="sticky top-0 bg-[var(--viz-surface)] text-left text-xs" style={{ color: "var(--viz-ink-2)" }}>
          <tr>
            <th className="py-1 font-medium">{bucket === "day" ? "Date" : bucket === "week" ? "Week of" : "Month"}</th>
            <th className="py-1 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {kpi.series.map((s) => (
            <tr key={s.bucket} className="border-t border-[var(--viz-grid)]">
              <td className="py-1">
                {formatDay(s.bucket, bucket)}
                {s.partial && <span style={{ color: "var(--viz-ink-2)" }}> (partial)</span>}
              </td>
              <td className="py-1 text-right">{formatValue(s.value, kpi.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SAMPLE_CSV = `date,metric,value
2026-09-01,Revenue,12400
2026-09-01,Support tickets,58
2026-09-02,Revenue,13150`;

export default function AnalyticsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [days, setDays] = useState<number>(30);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [table, setTable] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [insightsState, setInsightsState] = useState<"idle" | "loading" | "error">("idle");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return router.replace("/login");
      setNotice({ kind: "error", text: (err as Error).message });
    },
    [router],
  );

  // Request sequence numbers: when the user switches range quickly, a slow older response must not
  // overwrite the newer one (the 180-day query can easily finish after the 7-day one).
  const dashSeq = useRef(0);
  const insightsSeq = useRef(0);

  const loadDashboard = useCallback(async () => {
    const id = ++dashSeq.current;
    setLoading(true);
    try {
      const d = await api<DashboardData>(`/metrics/dashboard?days=${days}&bucket=${bucket}`);
      if (id === dashSeq.current) setData(d);
    } catch (err) {
      if (id === dashSeq.current) fail(err);
    } finally {
      if (id === dashSeq.current) setLoading(false);
    }
  }, [days, bucket, fail]);

  const loadInsights = useCallback(async () => {
    const id = ++insightsSeq.current;
    setInsightsState("loading");
    try {
      const r = await api<InsightsData>(`/metrics/insights?days=${days}`);
      if (id !== insightsSeq.current) return;
      setInsights(r);
      setInsightsState("idle");
    } catch {
      if (id !== insightsSeq.current) return;
      setInsights(null);
      setInsightsState("error");
    }
  }, [days]);

  useEffect(() => {
    api<Me>("/auth/me").then(setMe).catch(fail);
  }, [fail]);
  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);
  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  const markersByMetric = useMemo(() => {
    const out = new Map<string, ChartMarker[]>();
    for (const a of insights?.anomalies ?? []) {
      const list = out.get(a.metricId) ?? [];
      list.push({ x: a.day, expected: a.expected, deviationPct: a.deviationPct, bad: a.bad });
      out.set(a.metricId, list);
    }
    return out;
  }, [insights]);

  async function runAction(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const importCsv = (file: File) =>
    runAction("import", async () => {
      const body = new FormData();
      body.append("file", file);
      try {
        const r = await api<ImportResult>("/metrics/import", { method: "POST", body });
        const skipped = r.errorCount ? ` ${r.errorCount} row(s) skipped — first: line ${r.errors[0].line}, ${r.errors[0].message}.` : "";
        setNotice({ kind: "ok", text: `Imported ${r.imported.points} values for ${r.imported.metrics} metric(s).${skipped}` });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
      await Promise.all([loadDashboard(), loadInsights()]);
    });

  const loadDemo = () =>
    runAction("demo", async () => {
      const r = await api<ImportResult>("/metrics/demo", { method: "POST" });
      setNotice({ kind: "ok", text: `Loaded ${r.imported.metrics} demo metrics with 180 days of data.` });
      await Promise.all([loadDashboard(), loadInsights()]);
    });

  const exportAs = (format: "xlsx" | "pdf") =>
    runAction(format, () => download(`/metrics/export?format=${format}&days=${days}&bucket=${bucket}`, `opsmind-kpis.${format}`));

  const canImport = me && atLeast(me.role, "member");
  const isAdmin = me && atLeast(me.role, "admin");
  const empty = data && data.kpis.length === 0;
  const anomalies = insights?.anomalies ?? [];
  const visibleAnomalies = showAll ? anomalies : anomalies.slice(0, 5);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          {data && (
            <p className="text-sm" style={{ color: "var(--viz-ink-2)" }}>
              {formatDay(data.period.from)} – {formatDay(data.period.to)}, compared with the previous {days} days
            </p>
          )}
        </div>
      </div>

      {/* One filter row above everything it scopes. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-lg border border-zinc-300 p-0.5 dark:border-zinc-700">
          {RANGES.map((r) => (
            <button
              key={r}
              role="radio"
              aria-checked={days === r}
              onClick={() => {
                setDays(r);
                setShowAll(false);
              }}
              className={`rounded-md px-3 py-1 text-sm ${days === r ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
            >
              {r} days
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="bucket">
          Group by
        </label>
        <select
          id="bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value as Bucket)}
          className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          {BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <label className="ml-1 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={table} onChange={(e) => setTable(e.target.checked)} /> Table view
        </label>

        <div className="ml-auto flex flex-wrap gap-2">
          {canImport && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
              />
              <button className={button} disabled={!!busy} onClick={() => fileRef.current?.click()}>
                {busy === "import" ? "Importing…" : "Import CSV"}
              </button>
            </>
          )}
          {isAdmin && (
            <button className={button} disabled={!!busy} onClick={loadDemo}>
              {busy === "demo" ? "Loading…" : "Load demo data"}
            </button>
          )}
          <button className={button} disabled={!!busy || !!empty} onClick={() => exportAs("xlsx")}>
            {busy === "xlsx" ? "Exporting…" : "Export Excel"}
          </button>
          <button className={button} disabled={!!busy || !!empty} onClick={() => exportAs("pdf")}>
            {busy === "pdf" ? "Exporting…" : "Export PDF"}
          </button>
        </div>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className="mt-3 text-sm"
          style={{ color: notice.kind === "error" ? "var(--viz-critical-text)" : "var(--viz-ink-2)" }}
        >
          {notice.text}
        </p>
      )}

      {empty && (
        <section className={`${card} mt-6 p-6`}>
          <h2 className="font-medium">No KPI data yet</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--viz-ink-2)" }}>
            Import a CSV in long format: one row per date, metric and value. Comma, semicolon and tab files all work.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">{SAMPLE_CSV}</pre>
          {isAdmin && <p className="mt-3 text-sm">Or use <strong>Load demo data</strong> to explore with 180 days of sample metrics.</p>}
        </section>
      )}

      {data && !empty && (
        // Refetch keeps the frame: the previous render stays, dimmed, instead of a skeleton flash.
        <div className={`transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <section
            className={`${card} mt-6 p-5 transition-opacity ${insightsState === "loading" && insights ? "opacity-60" : ""}`}
            aria-live="polite"
            aria-busy={insightsState === "loading"}
          >
            <h2 className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--viz-ink-2)" }}>
              AI insights
              {/* The previous range's insights stay visible (dimmed) while the new range is analysed. */}
              {insightsState === "loading" && insights && <span className="text-xs font-normal">Updating…</span>}
            </h2>
            {insightsState === "loading" && !insights && <p className="mt-2 text-sm">Analyzing your metrics…</p>}
            {insightsState === "error" && (
              <p className="mt-2 text-sm" style={{ color: "var(--viz-ink-2)" }}>
                Insights are unavailable right now. The charts below are unaffected.{" "}
                <button className="underline" onClick={loadInsights}>
                  Retry
                </button>
              </p>
            )}
            {insights && (
              <>
                <p className="mt-2 leading-relaxed" style={{ color: "var(--viz-ink)" }}>
                  {insights.summary}
                </p>
                {anomalies.length > 0 && (
                  <>
                    <ul className="mt-3 space-y-0.5">
                      {visibleAnomalies.map((a) => (
                        <AnomalyRow key={`${a.metricId}-${a.day}`} a={a} />
                      ))}
                    </ul>
                    {anomalies.length > 5 && (
                      <button className="mt-2 text-sm underline" onClick={() => setShowAll(!showAll)}>
                        {showAll ? "Show fewer" : `Show all ${anomalies.length}`}
                      </button>
                    )}
                  </>
                )}
                {bucket !== "day" && anomalies.length > 0 && (
                  <p className="mt-2 text-xs" style={{ color: "var(--viz-ink-2)" }}>
                    Anomalies are detected on daily values; switch to Daily to see them on the charts.
                  </p>
                )}
              </>
            )}
          </section>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {data.kpis.map((k) => (
              <section key={k.id} id={`metric-${k.id}`} className={`${card} min-w-0 scroll-mt-20 p-5`}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-medium" style={{ color: "var(--viz-ink-2)" }}>
                    {k.name}
                  </h3>
                  <span className="text-xs" style={{ color: "var(--viz-ink-2)" }}>
                    {k.aggregation === "sum" ? "Total" : "Daily average"}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-semibold" style={{ color: "var(--viz-ink)" }}>
                  {formatValue(k.current, k.unit, { compact: true })}
                </p>
                <Delta kpi={k} days={days} />
                <div className="mt-3">
                  {k.series.length === 0 ? (
                    <p className="py-10 text-center text-sm" style={{ color: "var(--viz-ink-2)" }}>
                      No data in this period
                    </p>
                  ) : table ? (
                    <DataTable kpi={k} bucket={bucket} />
                  ) : (
                    <LineChart
                      points={k.series.map((s) => ({ x: s.bucket, value: s.value, partial: bucket !== "day" && s.partial }))}
                      markers={bucket === "day" ? markersByMetric.get(k.id) : undefined}
                      unit={k.unit}
                      bucket={bucket}
                      label={`${k.name}, ${BUCKETS.find((b) => b.value === bucket)!.label.toLowerCase()}`}
                    />
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
