const PREFIX_UNITS = new Set(["$", "€", "£"]);

function withUnit(v: number, n: string, unit: string): string {
  const sign = v < 0 ? "-" : "";
  if (PREFIX_UNITS.has(unit)) return `${sign}${unit}${n}`;
  if (unit === "%") return `${sign}${n}%`;
  return unit ? `${sign}${n} ${unit}` : `${sign}${n}`;
}

/**
 * Axis-label formatter for a whole tick set: one scale (K / M / B) for every tick and exactly as
 * many decimals as the step needs, so neighbouring ticks never round to the same label.
 */
export function tickFormatter(ticks: number[], unit: string): (t: number) => string {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  const max = Math.max(...ticks.map(Math.abs));
  const [div, suffix] = max >= 1e9 ? [1e9, "B"] : max >= 1e6 ? [1e6, "M"] : max >= 1e4 ? [1e3, "K"] : [1, ""];
  const digits = Math.min(10, Math.max(0, -Math.floor(Math.log10(step / div) + 1e-9)));
  return (t) => {
    if (t === 0) return withUnit(0, "0", unit);
    const n = (Math.abs(t) / div).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return withUnit(t, `${n}${suffix}`, unit);
  };
}

/** "$12,400" / "91.2%" / "6.5 h"; `compact` gives "$1.2M" for large stat-tile values. */
export function formatValue(v: number | null | undefined, unit = "", opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const n =
    opts.compact && abs >= 100_000
      ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(abs)
      : abs.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
  return withUnit(v, n, unit);
}

export function formatDeltaPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const r = Math.round(pct * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toLocaleString("en-US")}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 14" for days/weeks, "Sep 2026" for months. Parses ISO days without time-zone drift. */
export function formatDay(iso: string, bucket: "day" | "week" | "month" = "day"): string {
  const [y, m, d] = iso.split("-").map(Number);
  return bucket === "month" ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}`;
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
