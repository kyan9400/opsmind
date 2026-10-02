"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconAlert,
  IconAnalytics,
  IconArrowDown,
  IconArrowUp,
  IconCheckCircle,
  IconDatabase,
  IconDownload,
  IconFileSheet,
  IconInfo,
  IconSparkles,
  IconTrendDown,
  IconTrendUp,
  IconUpload,
} from "@/components/icons";
import { LineChart, type ChartMarker } from "@/components/LineChart";
import { EmptyState, Page, PageHeader } from "@/components/PageHeader";
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
import { useI18n } from "@/lib/i18n/provider";

const RANGES = [7, 30, 90, 180] as const;
const BUCKETS: Bucket[] = ["day", "week", "month"];

function isGood(k: Kpi): boolean | null {
  if (k.deltaPct === null || k.deltaPct === 0) return null;
  return k.direction === "up" ? k.deltaPct > 0 : k.deltaPct < 0;
}

function Delta({ kpi, days }: { kpi: Kpi; days: number }) {
  const { t, locale } = useI18n();
  const good = isGood(kpi);
  const tone = good === null ? "badge-neutral" : good ? "badge-success" : "badge-danger";
  // Arrows encode up/down, not reading direction, so they are not mirrored in RTL.
  const Arrow = kpi.deltaPct === null || kpi.deltaPct === 0 ? null : kpi.deltaPct > 0 ? IconArrowUp : IconArrowDown;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="kpi-delta">
      <span className={`badge ${tone} tabular-nums`} dir="ltr">
        {Arrow && <Arrow size={12} strokeWidth={2.4} />}
        {formatDeltaPct(kpi.deltaPct, locale)}
      </span>
      <span className="text-fg-subtle">{t("analytics.vsPrevious", { count: days })}</span>
    </p>
  );
}

function AnomalyRow({ a }: { a: Anomaly }) {
  const { t, locale } = useI18n();
  const Trend = a.kind === "spike" ? IconTrendUp : IconTrendDown;
  return (
    <li data-testid="anomaly-row">
      <a
        href={`#metric-${a.metricId}`}
        className="flex items-start gap-3 rounded-control border border-transparent px-3 py-2.5 transition-colors hover:border-line hover:bg-surface"
      >
        <span
          aria-hidden
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            a.bad ? "bg-danger-soft text-danger-text" : "bg-success-soft text-success"
          }`}
        >
          <Trend size={15} />
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium text-fg">
            {t("analytics.anomalyOn", {
              metric: a.metric,
              date: formatDay(a.day, "day", locale),
              value: formatValue(a.value, a.unit, { locale }),
            })}
          </span>
          {a.deviationPct !== null && (
            <span className="mt-0.5 block text-fg-muted">
              {t(a.kind === "spike" ? "analytics.anomalyAbove" : "analytics.anomalyBelow", {
                pct: Math.abs(Math.round(a.deviationPct)),
                expected: formatValue(a.expected, a.unit, { locale }),
              })}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
          <span className={`badge ${a.bad ? "badge-danger" : "badge-success"}`}>
            {a.bad ? t("analytics.needsAttention") : t("analytics.positive")}
          </span>
          <span className="badge border border-line text-fg-muted">{t(`analytics.severity.${a.severity}`)}</span>
        </span>
      </a>
    </li>
  );
}

function DataTable({ kpi, bucket }: { kpi: Kpi; bucket: Bucket }) {
  const { t, locale } = useI18n();
  return (
    <div className="max-h-[11rem] overflow-y-auto rounded-control border border-line">
      <table className="w-full text-sm tabular-nums" data-testid="kpi-table">
        <caption className="sr-only">{t(`analytics.caption.${bucket}`, { metric: kpi.name })}</caption>
        <thead className="sticky top-0 bg-muted text-xs text-fg-muted">
          <tr>
            <th className="px-3 py-1.5 text-start font-medium">
              {bucket === "day"
                ? t("analytics.colDate")
                : bucket === "week"
                  ? t("analytics.colWeekOf")
                  : t("analytics.colMonth")}
            </th>
            <th className="px-3 py-1.5 text-end font-medium">{t("analytics.colValue")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {kpi.series.map((s) => (
            <tr key={s.bucket} className="hover:bg-muted/60">
              <td className="px-3 py-1.5 text-fg">
                {formatDay(s.bucket, bucket, locale)}
                {s.partial && <span className="text-fg-subtle"> {t("common.partial")}</span>}
              </td>
              <td className="px-3 py-1.5 text-end text-fg">{formatValue(s.value, kpi.unit, { locale })}</td>
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
  const { t, locale } = useI18n();
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
        const ok = t("analytics.importOk", {
          values: t("analytics.nValues", { count: r.imported.points }),
          metrics: t("analytics.nMetrics", { count: r.imported.metrics }),
        });
        // Row errors come from the API and stay untranslated; only the framing sentence is localized.
        const skipped = r.errorCount
          ? ` ${t("analytics.skipped", { count: r.errorCount, line: String(r.errors[0].line), message: r.errors[0].message })}`
          : "";
        setNotice({ kind: "ok", text: `${ok}${skipped}` });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
      await Promise.all([loadDashboard(), loadInsights()]);
    });

  const loadDemo = () =>
    runAction("demo", async () => {
      const r = await api<ImportResult>("/metrics/demo", { method: "POST" });
      setNotice({ kind: "ok", text: t("analytics.demoOk", { count: r.imported.metrics }) });
      await Promise.all([loadDashboard(), loadInsights()]);
    });

  const exportAs = (format: "xlsx" | "pdf") =>
    runAction(format, () =>
      download(`/metrics/export?format=${format}&days=${days}&bucket=${bucket}`, `opsmind-kpis.${format}`),
    );

  const canImport = me && atLeast(me.role, "member");
  const isAdmin = me && atLeast(me.role, "admin");
  const empty = data && data.kpis.length === 0;
  const anomalies = insights?.anomalies ?? [];
  const visibleAnomalies = showAll ? anomalies : anomalies.slice(0, 5);
  const [demoBefore, demoAfter] = t("analytics.emptyDemo").split("{demo}");

  return (
    <Page>
      <PageHeader
        title={t("analytics.title")}
        description={
          data && (
            <p data-testid="analytics-period">
              {t("analytics.period", {
                count: days,
                from: formatDay(data.period.from, "day", locale),
                to: formatDay(data.period.to, "day", locale),
              })}
            </p>
          )
        }
        actions={
          <>
            {canImport && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
                  className="hidden"
                  data-testid="analytics-import-input"
                  onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
                />
                <button
                  className="btn btn-secondary"
                  disabled={!!busy}
                  onClick={() => fileRef.current?.click()}
                  data-testid="analytics-import"
                >
                  <IconUpload size={16} className="text-fg-subtle" />
                  {busy === "import" ? t("analytics.importing") : t("analytics.importCsv")}
                </button>
              </>
            )}
            {isAdmin && (
              <button className="btn btn-secondary" disabled={!!busy} onClick={loadDemo} data-testid="analytics-demo">
                <IconDatabase size={16} className="text-fg-subtle" />
                {busy === "demo" ? t("analytics.loadingDemo") : t("analytics.loadDemo")}
              </button>
            )}
          </>
        }
      />

      {/* One toolbar above everything it scopes: view controls at the start, exports at the end. */}
      <div className="card mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 p-2">
        <div
          role="radiogroup"
          aria-label={t("analytics.rangeLabel")}
          data-testid="analytics-range"
          className="segmented"
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={days === r}
              data-testid={`analytics-range-${r}`}
              onClick={() => {
                setDays(r);
                setShowAll(false);
              }}
              className="segment"
            >
              {t("analytics.range", { count: r })}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="bucket">
          {t("analytics.groupBy")}
        </label>
        <select
          id="bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value as Bucket)}
          data-testid="analytics-bucket"
          className="input h-9 w-auto cursor-pointer pe-8"
        >
          {BUCKETS.map((b) => (
            <option key={b} value={b}>
              {t(`analytics.bucket.${b}`)}
            </option>
          ))}
        </select>
        {/* A real checkbox laid invisibly over the switch, so it stays clickable, checkable and focusable. */}
        <label className="flex cursor-pointer items-center gap-2 px-1 text-sm font-medium text-fg-muted select-none">
          <span className="relative inline-flex h-5 w-9 shrink-0">
            <input
              type="checkbox"
              checked={table}
              onChange={(e) => setTable(e.target.checked)}
              data-testid="analytics-table-toggle"
              className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
            />
            <span
              aria-hidden
              className="absolute inset-0 rounded-full bg-line-strong transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"
            />
            <span
              aria-hidden
              className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ltr:peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4"
            />
          </span>
          {t("analytics.tableView")}
        </label>

        <div role="group" aria-label={t("analytics.export")} className="ms-auto inline-flex rounded-control shadow-xs">
          <button
            className="btn btn-secondary rounded-e-none shadow-none"
            disabled={!!busy || !!empty}
            onClick={() => exportAs("xlsx")}
            data-testid="analytics-export-xlsx"
          >
            <IconFileSheet size={16} className="text-fg-subtle" />
            {busy === "xlsx" ? t("analytics.exporting") : t("analytics.exportXlsx")}
          </button>
          <button
            className="btn btn-secondary -ms-px rounded-s-none shadow-none"
            disabled={!!busy || !!empty}
            onClick={() => exportAs("pdf")}
            data-testid="analytics-export-pdf"
          >
            <IconDownload size={16} className="text-fg-subtle" />
            {busy === "pdf" ? t("analytics.exporting") : t("analytics.exportPdf")}
          </button>
        </div>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          data-testid="analytics-notice"
          data-kind={notice.kind}
          className={`mt-3 flex items-start gap-2 rounded-control px-3 py-2 text-sm ${
            notice.kind === "error" ? "bg-danger-soft text-danger-text" : "bg-success-soft text-success"
          }`}
        >
          {notice.kind === "error" ? (
            <IconAlert size={16} className="mt-0.5" />
          ) : (
            <IconCheckCircle size={16} className="mt-0.5" />
          )}
          <span>{notice.text}</span>
        </p>
      )}

      {empty && (
        <section className="card mt-6" data-testid="analytics-empty">
          <EmptyState
            icon={<IconAnalytics size={22} />}
            title={t("analytics.emptyTitle")}
            body={t("analytics.emptyBody")}
          >
            {/* CSV is data, not prose: keep it LTR on Arabic pages. */}
            <pre
              dir="ltr"
              className="mt-5 w-full max-w-md overflow-x-auto rounded-control border border-line bg-muted p-3 text-start font-mono text-xs text-fg"
            >
              {SAMPLE_CSV}
            </pre>
            {isAdmin && (
              <p className="mt-4 text-sm text-fg-muted">
                {demoBefore}
                <strong className="text-fg">{t("analytics.loadDemo")}</strong>
                {demoAfter}
              </p>
            )}
          </EmptyState>
        </section>
      )}

      {data && !empty && (
        // Refetch keeps the frame: the previous render stays, dimmed, instead of a skeleton flash.
        <div className={`transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <section
            className={`mt-6 overflow-hidden rounded-card border border-brand-line bg-gradient-to-b from-brand-soft to-surface shadow-card transition-opacity ${
              insightsState === "loading" && insights ? "opacity-60" : ""
            }`}
            aria-live="polite"
            aria-busy={insightsState === "loading"}
            data-testid="insights-panel"
          >
            <div className="flex items-center gap-2.5 px-5 pt-4">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white"
              >
                <IconSparkles size={15} />
              </span>
              <h2 className="text-sm font-semibold text-fg">{t("analytics.insights")}</h2>
              {anomalies.length > 0 && <span className="badge badge-brand tabular-nums">{anomalies.length}</span>}
              {/* The previous range's insights stay visible (dimmed) while the new range is analysed. */}
              {insightsState === "loading" && insights && (
                <span className="text-xs text-fg-subtle">{t("analytics.updating")}</span>
              )}
            </div>
            <div className="px-5 pt-2 pb-4">
              {insightsState === "loading" && !insights && (
                <p className="text-sm text-fg-muted motion-safe:animate-pulse">{t("analytics.analyzing")}</p>
              )}
              {insightsState === "error" && (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <IconInfo size={16} />
                  <span>
                    {t("analytics.insightsError")}{" "}
                    <button
                      className="font-medium text-brand-text underline underline-offset-2"
                      onClick={loadInsights}
                      data-testid="insights-retry"
                    >
                      {t("analytics.retry")}
                    </button>
                  </span>
                </p>
              )}
              {insights && (
                <>
                  {/* The summary is generated in whatever language the API uses; let the text pick its own direction. */}
                  <p
                    className="max-w-4xl text-[0.9375rem] leading-relaxed text-fg"
                    dir="auto"
                    data-testid="insights-summary"
                  >
                    {insights.summary}
                  </p>
                  {anomalies.length > 0 && (
                    <>
                      <ul className="-mx-3 mt-3 space-y-0.5">
                        {visibleAnomalies.map((a) => (
                          <AnomalyRow key={`${a.metricId}-${a.day}`} a={a} />
                        ))}
                      </ul>
                      {anomalies.length > 5 && (
                        <button
                          className="btn btn-ghost btn-sm mt-2 -ms-2.5 text-brand-text"
                          onClick={() => setShowAll(!showAll)}
                          data-testid="insights-show-all"
                        >
                          {showAll ? t("analytics.showFewer") : t("analytics.showAll", { count: anomalies.length })}
                        </button>
                      )}
                    </>
                  )}
                  {bucket !== "day" && anomalies.length > 0 && (
                    <p className="mt-2 text-xs text-fg-subtle">{t("analytics.dailyOnly")}</p>
                  )}
                </>
              )}
            </div>
          </section>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {data.kpis.map((k) => (
              <section
                key={k.id}
                id={`metric-${k.id}`}
                data-testid="kpi-card"
                data-kpi-key={k.key}
                className="card min-w-0 scroll-mt-20 p-5 target:ring-2 target:ring-ring/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-medium text-fg-muted" data-testid="kpi-name">
                    {k.name}
                  </h3>
                  <span className="badge badge-neutral">
                    {k.aggregation === "sum" ? t("analytics.total") : t("analytics.dailyAverage")}
                  </span>
                </div>
                <p
                  className="mt-1.5 text-3xl font-semibold tracking-tight text-fg tabular-nums"
                  data-testid="kpi-value"
                >
                  {formatValue(k.current, k.unit, { compact: true, locale })}
                </p>
                <Delta kpi={k} days={days} />
                <div className="mt-4">
                  {k.series.length === 0 ? (
                    <p className="py-10 text-center text-sm text-fg-subtle">{t("analytics.noData")}</p>
                  ) : table ? (
                    <DataTable kpi={k} bucket={bucket} />
                  ) : (
                    <LineChart
                      points={k.series.map((s) => ({
                        x: s.bucket,
                        value: s.value,
                        partial: bucket !== "day" && s.partial,
                      }))}
                      markers={bucket === "day" ? markersByMetric.get(k.id) : undefined}
                      unit={k.unit}
                      bucket={bucket}
                      label={t("analytics.chartLabel", { metric: k.name, bucket: t(`analytics.bucketA11y.${bucket}`) })}
                    />
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
