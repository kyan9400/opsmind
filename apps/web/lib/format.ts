import { intlLocale, type Locale } from "./i18n/config";

const PREFIX_UNITS = new Set(["$", "€", "£"]);

/**
 * Arabic pages are RTL, so "6.5 h" or "+12%" would be reordered by the bidi algorithm ("h 6.5").
 * Unicode isolates keep a formatted value self-contained in any surrounding direction, including
 * inside the (LTR) chart SVG. Other locales get plain strings, so English output is unchanged.
 */
const LRI = "⁦";
const RLI = "⁧";
const PDI = "⁩";
const isolate = (s: string, locale: Locale, mark = LRI) => (locale === "ar" ? `${mark}${s}${PDI}` : s);

function withUnit(v: number, n: string, unit: string, locale: Locale): string {
  const sign = v < 0 ? "-" : "";
  let s: string;
  if (PREFIX_UNITS.has(unit)) s = `${sign}${unit}${n}`;
  else if (unit === "%") s = `${sign}${n}%`;
  else s = unit ? `${sign}${n} ${unit}` : `${sign}${n}`;
  return isolate(s, locale);
}

// Formatter construction is surprisingly expensive and these run per tick / per table row.
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function numberFormat(locale: Locale, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.NumberFormat(intlLocale(locale), opts)));
  return f;
}
function dateFormat(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(intlLocale(locale), opts)));
  return f;
}

/** Plain locale-aware number, e.g. for counts and file sizes. */
export function formatNumber(v: number, locale: Locale = "en", opts: Intl.NumberFormatOptions = {}): string {
  return numberFormat(locale, opts).format(v);
}

/**
 * Axis-label formatter for a whole tick set: one scale (K / M / B) for every tick and exactly as
 * many decimals as the step needs, so neighbouring ticks never round to the same label.
 * The short Latin suffixes are kept in every language: the axis gutter is ~50px wide.
 */
export function tickFormatter(ticks: number[], unit: string, locale: Locale = "en"): (t: number) => string {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  const max = Math.max(...ticks.map(Math.abs));
  const [div, suffix] = max >= 1e9 ? [1e9, "B"] : max >= 1e6 ? [1e6, "M"] : max >= 1e4 ? [1e3, "K"] : [1, ""];
  const digits = Math.min(10, Math.max(0, -Math.floor(Math.log10(step / div) + 1e-9)));
  const nf = numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (t) => {
    if (t === 0) return withUnit(0, "0", unit, locale);
    return withUnit(t, `${nf.format(Math.abs(t) / div)}${suffix}`, unit, locale);
  };
}

/** "$12,400" / "91.2%" / "6.5 h"; `compact` gives "$1.2M" for large stat-tile values. */
export function formatValue(
  v: number | null | undefined,
  unit = "",
  opts: { compact?: boolean; locale?: Locale } = {},
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const locale = opts.locale ?? "en";
  const abs = Math.abs(v);
  const n =
    opts.compact && abs >= 100_000
      ? numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(abs)
      : numberFormat(locale, { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 }).format(abs);
  return withUnit(v, n, unit, locale);
}

export function formatDeltaPct(pct: number | null | undefined, locale: Locale = "en"): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const r = Math.round(pct * 10) / 10;
  return isolate(`${r > 0 ? "+" : ""}${numberFormat(locale, {}).format(r)}%`, locale);
}

/** "Sep 14" for days/weeks, "Sep 2026" for months. Parses ISO days without time-zone drift. */
export function formatDay(iso: string, bucket: "day" | "week" | "month" = "day", locale: Locale = "en"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d || 1));
  const s = dateFormat(
    locale,
    bucket === "month" ? { month: "short", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" },
  ).format(date);
  // RTL isolate: "14 سبتمبر" must keep its Arabic order even inside the LTR chart.
  return isolate(s, locale, RLI);
}

/**
 * Clean axis ticks (1 / 2 / 5 x 10^n steps), d3-style. No 2.5 steps: with 1/2/5 every tick
 * needs at most as many decimals as the step itself, so labels never collide after rounding.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toFixed(10)));
  return ticks;
}
