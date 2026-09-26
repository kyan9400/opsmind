const PREFIX_UNITS = new Set(["$", "€", "£"]);

/** "$12,400" / "91.2%" / "6.5 h" / "1,284". Used by the Excel and PDF exports. */
export function formatValue(v: number | null | undefined, unit = "", decimals?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const d = decimals ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const n = abs.toLocaleString("en-US", { maximumFractionDigits: d });
  const sign = v < 0 ? "-" : "";
  if (PREFIX_UNITS.has(unit)) return `${sign}${unit}${n}`;
  if (unit === "%") return `${sign}${n}%`;
  return unit ? `${sign}${n} ${unit}` : `${sign}${n}`;
}

export function formatDeltaPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("en-US")}%`;
}
