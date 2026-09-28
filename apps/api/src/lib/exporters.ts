import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { eachDay } from "./dates.js";
import { formatDeltaPct, formatValue } from "./format.js";
import type { Insights } from "./insights.js";
import type { Dashboard, Kpi } from "./metrics.js";

export interface ReportData {
  tenantName: string;
  generatedAt: Date;
  dashboard: Dashboard;
  /** Daily points for the current period, keyed by metric id. */
  daily: Map<string, { day: string; value: number }[]>;
  /** Null when the AI service was unavailable; the report still renders without that section. */
  insights: Insights | null;
}

// Chart/ink tokens (light surface) shared with the web dashboard.
const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SERIES = "#2a78d6";
const STATUS = { goodText: "#006300", critical: "#d03b3b", good: "#0ca30c" };

/** Up-is-good metrics are good when they rise; down-is-good metrics when they fall. */
export function isGoodChange(kpi: Pick<Kpi, "direction" | "deltaPct">): boolean | null {
  if (kpi.deltaPct === null || kpi.deltaPct === 0) return null;
  return kpi.direction === "up" ? kpi.deltaPct > 0 : kpi.deltaPct < 0;
}

const periodLabel = (d: Dashboard) =>
  `${d.period.from} – ${d.period.to}  (compared with ${d.previousPeriod.from} – ${d.previousPeriod.to})`;

// ---------------------------------------------------------------- Excel

export async function buildXlsx(r: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OpsMind";
  wb.created = r.generatedAt;
  const header = (row: ExcelJS.Row) => {
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0EFEC" } };
  };

  // Summary
  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });
  summary.columns = [{ width: 30 }, { width: 10 }, { width: 13 }, { width: 16 }, { width: 16 }, { width: 12 }];
  summary.addRow([`OpsMind KPI report — ${r.tenantName}`]).font = { bold: true, size: 14 };
  summary.addRow([periodLabel(r.dashboard)]).font = { color: { argb: "FF52514E" } };
  summary.addRow([]);
  header(summary.addRow(["Metric", "Unit", "Aggregation", "Current period", "Previous period", "Change"]));
  for (const k of r.dashboard.kpis) {
    const row = summary.addRow([
      k.name,
      k.unit,
      k.aggregation === "sum" ? "Total" : "Average",
      k.current,
      k.previous,
      k.deltaPct === null ? null : k.deltaPct / 100,
    ]);
    row.getCell(4).numFmt = row.getCell(5).numFmt = "#,##0.##";
    row.getCell(6).numFmt = "+0.0%;-0.0%;0.0%";
    const good = isGoodChange(k);
    if (good !== null) row.getCell(6).font = { color: { argb: good ? "FF006300" : "FFD03B3B" } };
  }
  summary.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + r.dashboard.kpis.length, column: 6 } };
  if (r.insights) {
    summary.addRow([]);
    summary.addRow(["AI summary"]).font = { bold: true };
    const s = summary.addRow([r.insights.summary]);
    summary.mergeCells(s.number, 1, s.number, 6);
    s.getCell(1).alignment = { wrapText: true, vertical: "top" };
    s.height = 60;
  }

  // Daily data, one column per metric (wide format is what people chart in Excel).
  const data = wb.addWorksheet("Daily data", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  data.columns = [
    { header: "Date", width: 12 },
    ...r.dashboard.kpis.map((k) => ({ header: k.unit ? `${k.name} (${k.unit})` : k.name, width: Math.max(12, k.name.length + 6) })),
  ];
  header(data.getRow(1));
  const lookup = r.dashboard.kpis.map((k) => new Map((r.daily.get(k.id) ?? []).map((p) => [p.day, p.value])));
  for (const day of eachDay(r.dashboard.period.from, r.dashboard.period.to)) {
    const row = data.addRow([new Date(`${day}T00:00:00Z`), ...lookup.map((m) => m.get(day) ?? null)]);
    row.getCell(1).numFmt = "yyyy-mm-dd";
  }

  // Anomalies
  const anomalies = wb.addWorksheet("Anomalies", { views: [{ state: "frozen", ySplit: 1 }] });
  anomalies.columns = [
    { header: "Date", width: 12 },
    { header: "Metric", width: 28 },
    { header: "Value", width: 14 },
    { header: "Expected", width: 14 },
    { header: "Deviation", width: 12 },
    { header: "Severity", width: 10 },
    { header: "Assessment", width: 18 },
  ];
  header(anomalies.getRow(1));
  if (!r.insights) {
    anomalies.addRow(["AI insights were unavailable when this report was generated."]);
  } else {
    for (const a of r.insights.anomalies) {
      const row = anomalies.addRow([
        new Date(`${a.day}T00:00:00Z`),
        a.metric,
        a.value,
        a.expected,
        a.deviationPct === null ? null : a.deviationPct / 100,
        a.severity,
        a.bad ? "Needs attention" : "Positive",
      ]);
      row.getCell(1).numFmt = "yyyy-mm-dd";
      row.getCell(3).numFmt = row.getCell(4).numFmt = "#,##0.##";
      row.getCell(5).numFmt = "+0%;-0%;0%";
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- PDF

const require = createRequire(import.meta.url);
// DejaVu covers Latin, Cyrillic and Arabic glyphs; PDF's built-in Helvetica is Latin-1 only.
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const FONT_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

function sparkline(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  points: { day: string; value: number }[],
  flagged: Set<string>,
) {
  doc.save().lineWidth(0.5).strokeColor(INK.axis).moveTo(x, y + h).lineTo(x + w, y + h).stroke().restore();
  if (points.length < 2) return;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const px = (i: number) => x + (i / (points.length - 1)) * w;
  const py = (v: number) => y + h - ((v - min) / span) * h;

  doc.save().lineWidth(1.5).lineJoin("round").lineCap("round").strokeColor(SERIES);
  points.forEach((p, i) => (i === 0 ? doc.moveTo(px(i), py(p.value)) : doc.lineTo(px(i), py(p.value))));
  doc.stroke().restore();

  points.forEach((p, i) => {
    if (!flagged.has(p.day)) return;
    // Marker with a surface-coloured ring so it stays legible on the line.
    doc.save().circle(px(i), py(p.value), 3.5).lineWidth(1.5).fillAndStroke(STATUS.critical, "#ffffff").restore();
  });
}

export function buildPdf(r: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `OpsMind KPI report — ${r.tenantName}` } });
  doc.registerFont("Sans", FONT).registerFont("Sans-Bold", FONT_BOLD).font("Sans");
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (space: number) => {
    if (doc.y + space > bottom()) doc.addPage();
  };

  // Header
  doc.font("Sans-Bold").fontSize(18).fillColor(INK.primary).text("KPI report", left, doc.y);
  doc.font("Sans").fontSize(11).fillColor(INK.secondary).text(r.tenantName);
  doc.fontSize(9).fillColor(INK.muted).text(periodLabel(r.dashboard));
  doc.text(`Generated ${r.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  doc.moveDown(1);

  // AI summary
  if (r.insights?.summary) {
    ensure(70);
    doc.font("Sans-Bold").fontSize(11).fillColor(INK.primary).text("Summary");
    doc.font("Sans").fontSize(10).fillColor(INK.secondary).text(r.insights.summary, { width, lineGap: 2 });
    doc.moveDown(1);
  }

  // KPI cards: two columns, each with value, delta and a daily sparkline.
  const flaggedByMetric = new Map<string, Set<string>>();
  for (const a of r.insights?.anomalies ?? []) {
    if (!flaggedByMetric.has(a.metricId)) flaggedByMetric.set(a.metricId, new Set());
    flaggedByMetric.get(a.metricId)!.add(a.day);
  }
  const gap = 16;
  const cardW = (width - gap) / 2;
  const cardH = 104;
  doc.font("Sans-Bold").fontSize(11).fillColor(INK.primary).text("Metrics");
  doc.moveDown(0.5);
  r.dashboard.kpis.forEach((k, i) => {
    const col = i % 2;
    if (col === 0) ensure(cardH + gap);
    const x = left + col * (cardW + gap);
    const y = doc.y;
    doc.save().roundedRect(x, y, cardW, cardH, 6).lineWidth(0.5).strokeColor(INK.grid).stroke().restore();
    doc.font("Sans").fontSize(9).fillColor(INK.secondary).text(k.name, x + 12, y + 10, { width: cardW - 24, lineBreak: false, ellipsis: true });
    doc.font("Sans-Bold").fontSize(16).fillColor(INK.primary).text(formatValue(k.current, k.unit), x + 12, y + 24, { lineBreak: false });
    const good = isGoodChange(k);
    const arrow = k.deltaPct === null || k.deltaPct === 0 ? "" : k.deltaPct > 0 ? "▲ " : "▼ ";
    doc
      .font("Sans")
      .fontSize(9)
      .fillColor(good === null ? INK.muted : good ? STATUS.goodText : STATUS.critical)
      .text(`${arrow}${formatDeltaPct(k.deltaPct)} vs previous`, x + 12, y + 46, { lineBreak: false });
    sparkline(doc, x + 12, y + 64, cardW - 24, 28, r.daily.get(k.id) ?? [], flaggedByMetric.get(k.id) ?? new Set());
    doc.y = col === 1 || i === r.dashboard.kpis.length - 1 ? y + cardH + gap : y;
  });

  // Anomalies
  doc.x = left;
  ensure(60);
  doc.font("Sans-Bold").fontSize(11).fillColor(INK.primary).text("Unusual movements", left);
  doc.moveDown(0.3);
  if (!r.insights) {
    doc.font("Sans").fontSize(9).fillColor(INK.muted).text("AI insights were unavailable when this report was generated.");
  } else if (r.insights.anomalies.length === 0) {
    doc.font("Sans").fontSize(9).fillColor(INK.muted).text("No unusual movements in this period.");
  } else {
    for (const a of r.insights.anomalies) {
      ensure(18);
      const label = a.bad ? "Needs attention" : "Positive";
      const dev = a.deviationPct === null ? "" : ` (${formatDeltaPct(a.deviationPct)} vs expected ${formatValue(a.expected, a.unit)})`;
      const y = doc.y;
      doc.save().circle(left + 4, y + 5, 3).fill(a.bad ? STATUS.critical : STATUS.good).restore();
      doc
        .font("Sans")
        .fontSize(9)
        .fillColor(INK.primary)
        .text(`${a.day} · ${a.metric}: ${formatValue(a.value, a.unit)}${dev} — ${label}`, left + 14, y, { width: width - 14 });
      doc.moveDown(0.2);
    }
  }

  doc.end();
  return done;
}
