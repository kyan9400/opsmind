import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { createApp } from "../src/app.js";
import { metricKey, normaliseValue, parseMetricsCsv, sniffDelimiter } from "../src/lib/csv.js";
import { addDays, eachDay, periodsFor } from "../src/lib/dates.js";
import { generateDemoData } from "../src/lib/demoData.js";
import { buildPdf, buildXlsx, isGoodChange, type ReportData } from "../src/lib/exporters.js";
import { formatDeltaPct, formatValue } from "../src/lib/format.js";
import type { Dashboard } from "../src/lib/metrics.js";
import { bearer } from "./helpers/fakeDb.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

describe("csv import parsing", () => {
  it("accepts header aliases, semicolons, decimal commas and dd.mm.yyyy dates", () => {
    const csv = "﻿Date;KPI;Amount\n2026-09-01;Revenue;12 400,50\n02.09.2026;Revenue;1,250.75\n";
    const { rows, errors } = parseMetricsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { day: "2026-09-01", metric: "Revenue", value: 12400.5 },
      { day: "2026-09-02", metric: "Revenue", value: 1250.75 },
    ]);
  });

  it("uses one delimiter per file so decimal commas survive in semicolon files", () => {
    expect(sniffDelimiter("date;metric;value\n2026-09-01;Revenue;12,5")).toBe(";");
    expect(sniffDelimiter("date\tmetric\tvalue")).toBe("\t");
    expect(sniffDelimiter("date,metric,value")).toBe(",");
    expect(parseMetricsCsv("date;metric;value\n2026-09-01;Revenue;12,5\n").rows[0].value).toBe(12.5);
    // Quoted thousands separators in comma files still work.
    expect(parseMetricsCsv('date,metric,value\n2026-09-01,Revenue,"1,250.75"\n').rows[0].value).toBe(1250.75);
  });

  it("reports bad rows with line numbers instead of failing the file", () => {
    const csv = "date,metric,value\n2026-02-31,Revenue,10\n2026-09-01,,10\n2026-09-01,Orders,ten\n2026-09-02,Orders,5\n";
    const { rows, errors } = parseMetricsCsv(csv);
    expect(rows).toEqual([{ day: "2026-09-02", metric: "Orders", value: 5 }]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errors[0].message).toMatch(/invalid date/);
  });

  it("reads grouping and decimal separators by position and delimiter (no silent 1000x errors)", () => {
    expect(normaliseValue("1,234", ",")).toBe(1234); // quoted US grouping in a comma file
    expect(normaliseValue("12,400", ",")).toBe(12400);
    expect(normaliseValue("1,234,567.89", ",")).toBe(1234567.89);
    expect(normaliseValue("1.234,56", ";")).toBe(1234.56); // German
    expect(normaliseValue("12 400,50", ";")).toBe(12400.5); // Russian
    expect(normaliseValue("12,5", ";")).toBe(12.5);
    expect(normaliseValue("-0.5", ",")).toBe(-0.5);
    expect(normaliseValue("1".repeat(16), ",")).toBeNull(); // would overflow sums
    expect(normaliseValue("1e308", ",")).toBeNull();
    expect(parseMetricsCsv('date,metric,value\n2026-09-01,Revenue,"12,400"\n').rows[0].value).toBe(12400);
  });

  it("reports unquoted delimiters in values instead of importing a truncated number", () => {
    const { rows, errors } = parseMetricsCsv("date,metric,value\n2026-09-01,Revenue,12,5\n2026-09-02,Revenue,7,\n");
    expect(errors).toEqual([{ line: 2, message: expect.stringMatching(/more columns than the header/) }]);
    expect(rows).toEqual([{ day: "2026-09-02", metric: "Revenue", value: 7 }]); // trailing empty column is fine
  });

  it("never throws on malformed quotes, and reports physical line numbers", () => {
    expect(parseMetricsCsv('date,metric,value\n2026-09-01,Screen 27" sales,5\n').rows[0].metric).toBe('Screen 27" sales');
    const unclosed = parseMetricsCsv('date,metric,value\n2026-09-01,"Revenue,5\n');
    expect(unclosed.rows).toEqual([]);
    expect(unclosed.errors[0].message).toMatch(/could not read the file/);
    const gaps = parseMetricsCsv("date,metric,value\n\n\n2026-09-01,Revenue,x\n");
    expect(gaps.errors.map((e) => e.line)).toEqual([4]);
  });

  it("rejects files without the required columns", () => {
    expect(parseMetricsCsv("day,amount\n2026-09-01,5\n").errors[0].message).toMatch(/header/);
    expect(parseMetricsCsv("").errors[0].message).toMatch(/empty/);
  });

  it("builds stable, unicode-aware metric keys", () => {
    expect(metricKey("Avg. Resolution Time (h)")).toBe("avg-resolution-time-h");
    expect(metricKey("Выручка, ₽")).toBe("выручка");
    expect(metricKey("  REVENUE ")).toBe(metricKey("revenue"));
  });
});

describe("dates", () => {
  it("computes the period and the equally long previous period", () => {
    expect(periodsFor(30, "2026-09-26")).toEqual({
      current: { from: "2026-08-28", to: "2026-09-26" },
      previous: { from: "2026-07-29", to: "2026-08-27" },
    });
    expect(eachDay("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("demo data", () => {
  const to = "2026-09-26";
  const demo = generateDemoData(to);

  it("is deterministic and covers 180 days for six metrics", () => {
    expect(generateDemoData(to)).toEqual(demo);
    expect(demo).toHaveLength(6);
    expect(demo.every((m) => m.points.length === 180 && m.points.at(-1)!.day === to)).toBe(true);
  });

  it("contains the injected incidents", () => {
    const revenue = new Map(demo[0].points.map((p) => [p.day, p.value]));
    // 12 days ago revenue roughly halves vs the same weekday a week earlier.
    expect(revenue.get(addDays(to, -12))! / revenue.get(addDays(to, -19))!).toBeLessThan(0.7);
    expect(demo.find((m) => m.name === "Customer satisfaction")!.points.every((p) => p.value <= 100)).toBe(true);
  });
});

describe("formatting", () => {
  it("formats values and deltas", () => {
    expect(formatValue(12400, "$")).toBe("$12,400");
    expect(formatValue(91.24, "%")).toBe("91.2%");
    expect(formatValue(6.5, "h")).toBe("6.5 h");
    expect(formatValue(null, "$")).toBe("—");
    expect(formatDeltaPct(12.345)).toBe("+12.3%");
    expect(formatDeltaPct(-3)).toBe("-3%");
  });

  it("knows which direction is good", () => {
    expect(isGoodChange({ direction: "up", deltaPct: 5 })).toBe(true);
    expect(isGoodChange({ direction: "down", deltaPct: 5 })).toBe(false);
    expect(isGoodChange({ direction: "down", deltaPct: -5 })).toBe(true);
    expect(isGoodChange({ direction: "up", deltaPct: null })).toBeNull();
  });
});

describe("exports", () => {
  const dashboard: Dashboard = {
    period: { from: "2026-09-20", to: "2026-09-26" },
    previousPeriod: { from: "2026-09-13", to: "2026-09-19" },
    bucket: "day",
    kpis: [
      { id: "m1", key: "revenue", name: "Revenue", unit: "$", aggregation: "sum", direction: "up", current: 70000, previous: 65000, deltaPct: 7.69, series: [] },
      { id: "m2", key: "tickets", name: "Support tickets", unit: "", aggregation: "sum", direction: "down", current: 400, previous: 380, deltaPct: 5.26, series: [] },
    ],
  };
  const report: ReportData = {
    tenantName: "ООО Ромашка — شركة",
    generatedAt: new Date("2026-09-26T10:00:00Z"),
    dashboard,
    daily: new Map([
      ["m1", eachDay("2026-09-20", "2026-09-26").map((day, i) => ({ day, value: 10000 + i * 100 }))],
      ["m2", eachDay("2026-09-20", "2026-09-26").map((day, i) => ({ day, value: 50 + i }))],
    ]),
    insights: {
      summary: "Support tickets spiked on Sep 24.",
      provider: "template",
      ms: 3,
      anomalies: [
        { metricId: "m2", metric: "Support tickets", unit: "", day: "2026-09-24", value: 120, expected: 55, deviationPct: 118.2, z: 9.1, severity: "high", kind: "spike", bad: true },
      ],
    },
  };

  it("builds an Excel workbook with typed cells", async () => {
    const buf = await buildXlsx(report);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Daily data", "Anomalies"]);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell("A1").value).toContain("ООО Ромашка");
    expect(summary.getCell("D5").value).toBe(70000);
    expect(summary.getCell("F5").value).toBeCloseTo(0.0769);
    const data = wb.getWorksheet("Daily data")!;
    expect(data.rowCount).toBe(8); // header + 7 days
    expect(data.getCell("B2").value).toBe(10000);
    expect(wb.getWorksheet("Anomalies")!.getCell("G2").value).toBe("Needs attention");
  });

  it("builds a PDF, including non-Latin text, with and without AI insights", async () => {
    const pdf = await buildPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const noAi = await buildPdf({ ...report, insights: null });
    expect(noAi.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("metrics http (no database)", () => {
  const app = createApp();
  const token = (role: "viewer" | "member" | "admin") => bearer(role);

  it("validates dashboard queries", async () => {
    await request(app).get("/api/v1/metrics/dashboard?days=1000").set("authorization", token("viewer")).expect(400);
    await request(app).get("/api/v1/metrics/dashboard?bucket=year").set("authorization", token("viewer")).expect(400);
    await request(app).get("/api/v1/metrics/dashboard?to=2026-02-31").set("authorization", token("viewer")).expect(400);
    // Out-of-range month/day used to throw inside the validator (500).
    await request(app).get("/api/v1/metrics/dashboard?to=2026-13-01").set("authorization", token("viewer")).expect(400);
    await request(app).get("/api/v1/metrics/insights?to=2026-02-32").set("authorization", token("viewer")).expect(400);
    await request(app).get("/api/v1/metrics/dashboard?to=0001-01-01").set("authorization", token("viewer")).expect(400);
    await request(app).get("/api/v1/metrics/export?format=docx").set("authorization", token("viewer")).expect(400);
  });

  it("enforces roles on writes", async () => {
    await request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", token("viewer"))
      .attach("file", Buffer.from("date,metric,value\n"), "kpis.csv")
      .expect(403);
    await request(app).post("/api/v1/metrics/demo").set("authorization", token("member")).expect(403);
    await request(app).delete("/api/v1/metrics/x").set("authorization", token("member")).expect(403);
  });

  it("rejects non-CSV uploads", async () => {
    await request(app)
      .post("/api/v1/metrics/import")
      .set("authorization", token("member"))
      .attach("file", Buffer.from("x"), "kpis.xlsx")
      .expect(415);
  });
});
