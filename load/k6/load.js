// Load: ramp 0 -> 20 -> 50 -> 0 VUs against a read-heavy mix that mirrors how
// the dashboard is used (mostly KPI views, occasional questions to the AI).
//   k6 run -e API=http://localhost:4000 -e DURATION_SCALE=0.3 load/k6/load.js
// Run from the repo root: handleSummary writes to load/results/ (override with RESULTS_DIR).
import { sleep } from "k6";
import { bootstrapTenant, endpoints } from "./lib.js";

const SCALE = Number(__ENV.DURATION_SCALE || 1);
if (!(SCALE > 0)) throw new Error(`DURATION_SCALE must be > 0, got ${__ENV.DURATION_SCALE}`);
const RESULTS_DIR = (__ENV.RESULTS_DIR || "load/results").replace(/\/+$/, "");

// Scaling keeps the shape of the profile (ramp, plateau, drain) while letting CI
// trade duration for runner minutes; a stage never drops below 1s.
const secs = (s) => `${Math.max(1, Math.round(s * SCALE))}s`;

// Order matters only for readability; weights must sum to 100.
const MIX = [
  { name: "dashboard", weight: 50, p95: 300 },
  { name: "insights", weight: 20, p95: 200 },
  { name: "ask", weight: 15, p95: 800 },
  { name: "documents", weight: 10, p95: 200 },
  { name: "me", weight: 5, p95: 100 },
];

const thresholds = { http_req_failed: ["rate<0.01"] };
for (const { name, p95 } of MIX) {
  thresholds[`http_req_duration{name:${name}}`] = [`p(95)<${p95}`];
  // Always-true threshold: it exists only to make k6 materialise the per-endpoint
  // sub-metric so handleSummary can report request counts and error rates.
  thresholds[`http_req_failed{name:${name}}`] = ["rate>=0"];
}

export const options = {
  setupTimeout: "180s",
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: secs(30), target: 20 },
        { duration: secs(30), target: 50 },
        { duration: secs(90), target: 50 },
        { duration: secs(30), target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds,
};

export function setup() {
  return bootstrapTenant({ withDocument: true });
}

const TOTAL = MIX.reduce((sum, e) => sum + e.weight, 0);

export default function ({ token }) {
  let roll = Math.random() * TOTAL;
  const target = MIX.find((e) => (roll -= e.weight) < 0) || MIX[0];
  endpoints[target.name](token);
  // Think time: without it 50 VUs become a tight loop that measures the client, not the API.
  sleep(0.5 + Math.random());
}

// --- summary -----------------------------------------------------------------

const fmtMs = (v) => (typeof v === "number" ? `${v.toFixed(1)} ms` : "n/a");

function thresholdLines(data) {
  const lines = [];
  for (const [metric, m] of Object.entries(data.metrics)) {
    for (const [expr, t] of Object.entries(m.thresholds || {})) {
      if (expr === "rate>=0") continue; // reporting-only, see above
      lines.push({ ok: t.ok, text: `${metric}: ${expr}` });
    }
  }
  return lines.sort((a, b) => a.text.localeCompare(b.text));
}

function rows(data) {
  return MIX.map(({ name, p95: budget }) => {
    const d = data.metrics[`http_req_duration{name:${name}}`];
    const f = data.metrics[`http_req_failed{name:${name}}`];
    const dv = (d && d.values) || {};
    const fv = (f && f.values) || {};
    const requests = (fv.passes || 0) + (fv.fails || 0);
    return {
      endpoint: name,
      requests,
      p50: dv.med,
      p95: dv["p(95)"],
      p99: dv["p(99)"],
      budget,
      errorPct: requests ? (fv.rate || 0) * 100 : 0,
    };
  });
}

function markdown(data) {
  const r = rows(data);
  const th = thresholdLines(data);
  const failedAll = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate * 100 : 0;
  const passed = th.every((t) => t.ok);
  const out = [
    `## Load test ${passed ? "passed" : "FAILED"}`,
    "",
    `Target \`${__ENV.API || "http://localhost:4000"}\`, duration scale ${SCALE}, ` +
      `${data.metrics.iterations ? data.metrics.iterations.values.count : 0} iterations, ` +
      `overall error rate ${failedAll.toFixed(2)}%.`,
    "",
    "| Endpoint | Requests | p50 | p95 | p99 | p95 budget | Error % |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...r.map(
      (x) =>
        `| ${x.endpoint} | ${x.requests} | ${fmtMs(x.p50)} | ${fmtMs(x.p95)} | ${fmtMs(x.p99)} | ` +
        `${x.budget} ms | ${x.errorPct.toFixed(2)}% |`,
    ),
    "",
    "### Thresholds",
    "",
    ...th.map((t) => `- ${t.ok ? "PASS" : "FAIL"} \`${t.text}\``),
    "",
  ];
  return out.join("\n");
}

export function handleSummary(data) {
  const md = markdown(data);
  return {
    stdout: `\n${md}\n`,
    [`${RESULTS_DIR}/summary.md`]: md,
    [`${RESULTS_DIR}/summary.json`]: JSON.stringify(data, null, 2),
  };
}
