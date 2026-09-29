"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatDay, formatDeltaPct, formatValue, niceTicks, tickFormatter } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";

export interface ChartPoint {
  x: string; // ISO day (bucket start)
  value: number;
  partial?: boolean;
}

export interface ChartMarker {
  x: string;
  expected: number;
  deviationPct: number | null;
  bad: boolean;
}

interface Props {
  points: ChartPoint[];
  markers?: ChartMarker[];
  unit: string;
  bucket: "day" | "week" | "month";
  label: string; // accessible name, e.g. "Revenue, daily"
  height?: number;
}

const M = { top: 10, right: 12, bottom: 26, left: 52 };

/**
 * Single-series line chart: 2px line with a 10% area wash, hairline grid, snapping crosshair
 * + tooltip on hover and arrow keys, and status-coloured anomaly markers with a surface ring.
 */
export function LineChart({ points, markers = [], unit, bucket, label, height = 170 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const gradientId = useId();
  const { t, locale, dir } = useI18n();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const markerByX = useMemo(() => new Map(markers.map((m) => [m.x, m])), [markers]);

  const geo = useMemo(() => {
    if (points.length === 0 || width === 0) return null;
    const values = points.map((p) => p.value);
    let lo = Math.min(...values);
    const hi = Math.max(...values);
    // Anchor to zero when the data sits reasonably close to it; otherwise zoom to the data.
    if (lo >= 0 && lo <= hi * 0.5) lo = 0;
    const ticks = niceTicks(lo, hi);
    const y0 = ticks[0];
    const y1 = ticks.at(-1)!;
    const w = width - M.left - M.right;
    const h = height - M.top - M.bottom;
    const x = (i: number) => M.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
    const y = (v: number) => M.top + h - ((v - y0) / (y1 - y0 || 1)) * h;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(1)},${M.top + h}L${x(0).toFixed(1)},${M.top + h}Z`;
    const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(w / 80))));
    return { ticks, fmtTick: tickFormatter(ticks, unit, locale), x, y, line, area, w, h, labelEvery };
  }, [points, width, height, unit, locale]);

  function onPointer(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setActive(Math.round(Math.min(1, Math.max(0, rel)) * (points.length - 1)));
  }

  function onKey(e: React.KeyboardEvent) {
    const last = points.length - 1;
    if (e.key === "ArrowRight") setActive((a) => Math.min(last, a === null || a > last ? 0 : a + 1));
    else if (e.key === "ArrowLeft") setActive((a) => Math.max(0, a === null || a > last ? last : a - 1));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  }

  // `points` can shrink while a point is hovered (e.g. switching 30 -> 7 days); never index past the end.
  const idx = active !== null && active < points.length ? active : null;
  const p = idx !== null ? points[idx] : null;
  const marker = p ? markerByX.get(p.x) : undefined;

  return (
    // Time runs left to right in every language, so the chart (geometry, keyboard, tick anchors) stays
    // LTR on Arabic pages too; only the tooltip text follows the page direction.
    <div ref={wrapRef} dir="ltr" className="relative w-full min-w-0" style={{ height }} data-testid="line-chart">
      {geo && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={t("chart.a11y", { label })}
          tabIndex={0}
          onKeyDown={onKey}
          onFocus={() => setActive((a) => a ?? points.length - 1)}
          onBlur={() => setActive(null)}
          // Absolutely positioned so the measured width never props the container open (no resize feedback loop).
          className="absolute inset-0 block rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--viz-series-1)]"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--viz-series-1)" stopOpacity="0.12" />
              <stop offset="1" stopColor="var(--viz-series-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Hairline grid + tick labels */}
          {geo.ticks.map((t, i) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + geo.w}
                y1={geo.y(t)}
                y2={geo.y(t)}
                stroke={i === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 8}
                y={geo.y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--viz-muted)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {geo.fmtTick(t)}
              </text>
            </g>
          ))}
          {points.map((pt, i) =>
            i % geo.labelEvery === 0 ? (
              <text
                key={pt.x}
                x={geo.x(i)}
                y={height - 8}
                // The last label sits at the plot's right edge: anchor it inward so it isn't clipped.
                textAnchor={points.length > 1 && i === points.length - 1 ? "end" : "middle"}
                fontSize={11}
                fill="var(--viz-muted)"
              >
                {formatDay(pt.x, bucket, locale)}
              </text>
            ) : null,
          )}

          <path d={geo.area} fill={`url(#${gradientId})`} />
          <path d={geo.line} fill="none" stroke="var(--viz-series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {/* A single point has no line to draw: show it as a dot. */}
          {points.length === 1 && !points[0].partial && (
            <circle cx={geo.x(0)} cy={geo.y(points[0].value)} r={4} fill="var(--viz-series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
          )}

          {/* Partial buckets: hollow markers, the value covers only part of that week/month. */}
          {points.map((pt, i) =>
            pt.partial ? (
              <circle key={`p-${pt.x}`} cx={geo.x(i)} cy={geo.y(pt.value)} r={4} fill="var(--viz-surface)" stroke="var(--viz-series-1)" strokeWidth={2} />
            ) : null,
          )}

          {/* Crosshair */}
          {idx !== null && (
            <line
              x1={geo.x(idx)}
              x2={geo.x(idx)}
              y1={M.top}
              y2={M.top + geo.h}
              stroke="var(--viz-axis)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}

          {/* Anomaly markers: status colour, 2px surface ring. */}
          {points.map((pt, i) => {
            const m = markerByX.get(pt.x);
            return m ? (
              <circle
                key={`a-${pt.x}`}
                cx={geo.x(i)}
                cy={geo.y(pt.value)}
                r={5}
                fill={m.bad ? "var(--viz-critical)" : "var(--viz-good)"}
                stroke="var(--viz-surface)"
                strokeWidth={2}
              />
            ) : null;
          })}

          {/* Hover dot, unless an anomaly marker already sits there (it must stay visible). */}
          {p && idx !== null && !marker && (
            <circle
              cx={geo.x(idx)}
              cy={geo.y(p.value)}
              r={4}
              fill="var(--viz-series-1)"
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          )}

          {/* Hit layer: the whole plot, so the pointer only has to be near a date. */}
          <rect
            x={M.left}
            y={M.top}
            width={geo.w}
            height={geo.h}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      )}

      {geo && p && idx !== null && (
        <div
          role="status"
          dir={dir}
          data-testid="chart-tooltip"
          className="pointer-events-none absolute z-10 min-w-36 rounded-lg border px-3 py-2 text-start text-xs shadow-lg"
          style={{
            top: 0,
            // Sit beside the crosshair, flipping sides past 60% so it never covers the hovered point.
            ...(geo.x(idx) > width * 0.6 ? { right: width - geo.x(idx) + 12 } : { left: geo.x(idx) + 12 }),
            background: "var(--viz-surface)",
            borderColor: "var(--viz-border)",
          }}
        >
          <div style={{ color: "var(--viz-ink-2)" }}>
            {bucket === "week"
              ? t("chart.weekOf", { date: formatDay(p.x, bucket, locale) })
              : formatDay(p.x, bucket, locale)}
            {p.partial && ` ${t("common.partial")}`}
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-series-1)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--viz-ink)" }}>
              {formatValue(p.value, unit, { locale })}
            </span>
          </div>
          {marker && (
            <div className="mt-1" style={{ color: marker.bad ? "var(--viz-critical-text)" : "var(--viz-good-text)" }}>
              {t(marker.bad ? "chart.markerBad" : "chart.markerGood", {
                delta: formatDeltaPct(marker.deviationPct, locale),
                expected: formatValue(marker.expected, unit, { locale }),
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
