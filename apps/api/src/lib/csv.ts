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

/**
 * Tolerate grouping and decimal separators from any locale: "12 400,50", "1.234,56", "12,400.50".
 * When both "," and "." appear, the rightmost one is the decimal separator. A lone comma is a
 * decimal separator only in ";"/tab files; in comma files it had to be quoted, so it is grouping
 * ("12,400" is twelve thousand four hundred, not 12.4).
 */
export function normaliseValue(raw: string, delimiter = ","): number | null {
  let s = raw.trim().replace(/[\s ']/g, "");
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma >= 0) s = delimiter !== "," && /^-?\d+,\d+$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  // Bounded digits keep sums over a year of values finite (no Infinity reaching Postgres, charts or reports).
  if (!/^-?\d{1,15}(\.\d{1,10})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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
  const delimiter = sniffDelimiter(text);
  type Row = { record: string[]; info: { lines: number } };
  let records: Row[];
  try {
    // csv-parse's typings don't model `info: true`, which wraps each record with its position.
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true, // tolerate Excel's trailing empty columns; real extra fields are reported below
      relax_quotes: true, // a stray quote in an unquoted field (Screen 27" sales) is data, not syntax
      delimiter,
      info: true, // physical line numbers, correct even after blank lines or multi-line quoted fields
    }) as unknown as Row[];
  } catch (err) {
    // Unclosed quotes etc.: report as a user error on the line csv-parse stopped at, not a 500.
    const e = err as Error & { lines?: number };
    return { rows: [], errors: [{ line: e.lines ?? 1, message: `could not read the file: ${e.message}` }] };
  }
  if (records.length === 0) return { rows: [], errors: [{ line: 1, message: "file is empty" }] };

  const headerCells = records[0].record;
  const header = headerCells.map((h) => ALIASES[h.toLowerCase()]);
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
  records.slice(1).forEach(({ record: r, info }) => {
    const line = info.lines;
    // e.g. an unquoted "12,5" in a comma file splits into two fields: reject rather than import 12.
    if (r.length > headerCells.length && r.slice(headerCells.length).some((c) => c !== "")) {
      errors.push({ line, message: "more columns than the header — quote values that contain the delimiter" });
      return;
    }
    const day = normaliseDay(r[iDay] ?? "");
    const metric = (r[iMetric] ?? "").trim();
    const value = normaliseValue(r[iValue] ?? "", delimiter);
    if (!day) errors.push({ line, message: `invalid date "${r[iDay] ?? ""}" (use YYYY-MM-DD)` });
    else if (!metric || metric.length > 80) errors.push({ line, message: "metric name must be 1-80 characters" });
    else if (value === null) errors.push({ line, message: `invalid number "${r[iValue] ?? ""}" (max 15 digits)` });
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
