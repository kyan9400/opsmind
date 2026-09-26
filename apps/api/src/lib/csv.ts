import { parse } from "csv-parse/sync";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;

export interface MetricRow {
  day: string;
  metric: string;
  value: number;
}

export interface ParseResult {
  rows: MetricRow[];
  errors: { line: number; message: string }[];
}

// Accept the header names people actually export from spreadsheets.
const ALIASES: Record<string, keyof MetricRow> = {
  date: "day",
  day: "day",
  metric: "metric",
  kpi: "metric",
  name: "metric",
  value: "value",
  amount: "value",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function normaliseDay(raw: string): string | null {
  const s = raw.trim();
  const iso = ISO_DAY.test(s) ? s : /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(s)?.slice(1).reverse().join("-");
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  // Reject impossible dates like 2026-02-31 that Date silently rolls over.
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
}

function normaliseValue(raw: string): number | null {
  // Tolerate thousands separators and decimal commas: "12 400,50" / "12,400.50".
  let s = raw.trim().replace(/[\s ']/g, "");
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * Pick the delimiter from the header line. It must be one delimiter per file: with ";" files
 * (common in RU/EU Excel exports) a decimal comma like "12,5" is part of the value.
 */
export function sniffDelimiter(text: string): string {
  const header = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", "\t", ","].map((d) => [d, header.split(d).length - 1] as const);
  const [best, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n > 0 ? best : ",";
}

/**
 * Parse a long-format KPI CSV (`date,metric,value`). Bad rows are reported with their
 * line number instead of failing the whole import.
 */
export function parseMetricsCsv(input: string | Buffer): ParseResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const records: string[][] = parse(text, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter: sniffDelimiter(text),
  });
  if (records.length === 0) return { rows: [], errors: [{ line: 1, message: "file is empty" }] };

  const header = records[0].map((h) => ALIASES[h.toLowerCase()]);
  const col = (k: keyof MetricRow) => header.indexOf(k);
  const [iDay, iMetric, iValue] = [col("day"), col("metric"), col("value")];
  if (iDay < 0 || iMetric < 0 || iValue < 0) {
    return { rows: [], errors: [{ line: 1, message: "header must contain date, metric and value columns" }] };
  }
  if (records.length - 1 > MAX_CSV_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `too many rows (max ${MAX_CSV_ROWS})` }] };
  }

  const rows: MetricRow[] = [];
  const errors: ParseResult["errors"] = [];
  records.slice(1).forEach((r, i) => {
    const line = i + 2;
    const day = normaliseDay(r[iDay] ?? "");
    const metric = (r[iMetric] ?? "").trim();
    const value = normaliseValue(r[iValue] ?? "");
    if (!day) errors.push({ line, message: `invalid date "${r[iDay] ?? ""}" (use YYYY-MM-DD)` });
    else if (!metric || metric.length > 80) errors.push({ line, message: "metric name must be 1-80 characters" });
    else if (value === null) errors.push({ line, message: `invalid number "${r[iValue] ?? ""}"` });
    else rows.push({ day, metric, value });
  });
  return { rows, errors };
}

/** Stable key for a metric name: "Avg. Resolution Time (h)" -> "avg-resolution-time-h". Unicode-aware. */
export function metricKey(name: string): string {
  return (
    name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "metric"
  );
}
