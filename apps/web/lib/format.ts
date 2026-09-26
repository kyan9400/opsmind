const PREFIX_UNITS = new Set(["$", "€", "£"]);

/** "$12,400" / "91.2%" / "6.5 h"; `compact` gives "$1.2M" for large stat-tile values. */
export function formatValue(v: number | null | undefined, unit = "", opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const n =
    opts.compact && abs >= 100_000
      ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(abs)
      : abs.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
  const sign = v < 0 ? "-" : "";
  if (PREFIX_UNITS.has(unit)) return `${sign}${unit}${n}`;
  if (unit === "%") return `${sign}${n}%`;
  return unit ? `${sign}${n} ${unit}` : `${sign}${n}`;
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

/** Clean axis ticks (1 / 2 / 2.5 / 5 x 10^n steps), d3-style. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toFixed(10)));
  return ticks;
}
