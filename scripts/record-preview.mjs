#!/usr/bin/env node
/**
 * Records everything the static interactive preview replays (apps/web/lib/mock) from a running stack
 * with the demo workspace seeded, signed in as the read-only demo viewer:
 *
 *   docker compose exec -T -e DEMO_EMAIL=demo@opsmind.dev -e DEMO_PASSWORD=opsmind-demo api node dist/seedDemo.js
 *   DEMO_PASSWORD=opsmind-demo node scripts/record-preview.mjs
 *
 * Writes apps/web/preview-data/ (generated and git-ignored; CI records it fresh on every run):
 *   meta.json       recording day, source, demo account, which view the exports are for
 *   responses.json  every GET the UI makes, keyed "GET /path?query" -> { status, body }
 *   ask.json        the Ask page's example questions in EN/RU/AR -> { status, body, answeredAs? }
 *   export.xlsx, export.pdf   the KPI report for the default view (30 days, daily)
 *
 * Node 22, no dependencies. Env: API (default http://localhost:4000), DEMO_EMAIL (default
 * demo@opsmind.dev), DEMO_PASSWORD (required), PREVIEW_DATA_DIR, WAIT_SECONDS (default 180).
 * No token or password is written: the preview signs in against its own mock.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.API ?? "http://localhost:4000").replace(/\/+$/, "");
const EMAIL = process.env.DEMO_EMAIL ?? "demo@opsmind.dev";
const PASSWORD = process.env.DEMO_PASSWORD;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(process.env.PREVIEW_DATA_DIR ?? join(ROOT, "apps/web/preview-data"));
const WAIT_MS = Number(process.env.WAIT_SECONDS ?? 180) * 1000;

// Everything the analytics page can ask for (apps/web/app/dashboard/analytics/page.tsx).
const RANGES = [7, 30, 90, 180];
const BUCKETS = ["day", "week", "month"];
const LOCALES = ["en", "ru", "ar"];
// Its defaults: the only view the preview offers exports for.
const EXPORT_VIEW = { days: 30, bucket: "day" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => {
  console.error(`record-preview: ${msg}`);
  process.exit(1);
};
if (!PASSWORD) die("set DEMO_PASSWORD (the password the demo workspace was seeded with)");

let token = null;

/** One API call; waits out 429s (AI_RATE_LIMIT) instead of recording them. */
async function call(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) {
      await sleep(Math.min(60, Number(res.headers.get("retry-after")) || 10) * 1000);
      continue;
    }
    return res;
  }
}

async function json(method, path, body) {
  const res = await call(method, path, body);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A response the preview cannot do without: anything but 200 stops the recording. */
async function required(method, path, body) {
  const r = await json(method, path, body);
  if (r.status !== 200) die(`${method} ${path} -> HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

async function waitForApi() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) die(`${API}/health did not answer within ${WAIT_MS / 1000}s`);
    await sleep(2000);
  }
}

/** The seed queues its documents for the worker; Ask answers are only worth recording once all are indexed. */
async function waitForDocuments() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { body } = await required("GET", "/documents");
    const docs = body.data;
    const failed = docs.filter((d) => d.status === "failed");
    if (failed.length) die(`indexing failed: ${failed.map((d) => `${d.title} (${d.error})`).join(", ")}`);
    if (docs.length && docs.every((d) => d.status === "ready")) return docs.length;
    if (Date.now() > deadline) {
      die(`documents not ready after ${WAIT_MS / 1000}s: ${docs.map((d) => `${d.title}=${d.status}`).join(", ") || "none"}`);
    }
    await sleep(2000);
  }
}

/** The example questions exactly as the UI sends them, read from the translation files. */
function exampleQuestions() {
  return LOCALES.flatMap((locale) => {
    const src = readFileSync(join(ROOT, `apps/web/lib/i18n/${locale}.ts`), "utf8");
    const found = [...src.matchAll(/"(ask\.example\d)":\s*("(?:[^"\\]|\\.)*")/g)].map((m) => ({
      locale,
      key: m[1],
      question: JSON.parse(m[2]),
    }));
    if (found.length !== 3) die(`expected 3 ask.example* strings in apps/web/lib/i18n/${locale}.ts, found ${found.length}`);
    return found;
  });
}

async function recordExport(format) {
  const { days, bucket } = EXPORT_VIEW;
  const res = await call("GET", `/metrics/export?format=${format}&days=${days}&bucket=${bucket}`);
  if (!res.ok) die(`export ${format} -> HTTP ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const magic = format === "xlsx" ? "PK" : "%PDF";
  if (bytes.subarray(0, magic.length).toString("latin1") !== magic) die(`export ${format} is not a ${format} file`);
  writeFileSync(join(OUT, `export.${format}`), bytes);
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  return { name: name ?? `opsmind-kpis.${format}`, size: bytes.length };
}

await waitForApi();
const login = await required("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
token = login.body.token;

const me = await required("GET", "/auth/me");
// Everything a viewer cannot do is hidden in the UI; a stronger account would show buttons the preview can't honour.
if (me.body.role !== "viewer") die(`${EMAIL} is a ${me.body.role}; the preview must replay the read-only demo viewer`);
const documents = await waitForDocuments();

const responses = { "GET /auth/me": me };
for (const path of ["/users", "/documents"]) responses[`GET ${path}`] = await required("GET", path);
// The overview only asks admins for the audit trail; kept as the API answers it (403 for a viewer).
responses["GET /audit?limit=10"] = await json("GET", "/audit?limit=10");
for (const days of RANGES) {
  for (const bucket of BUCKETS) {
    const path = `/metrics/dashboard?days=${days}&bucket=${bucket}`;
    responses[`GET ${path}`] = await required("GET", path);
  }
  const path = `/metrics/insights?days=${days}`;
  responses[`GET ${path}`] = await required("GET", path);
}

// All periods end "today" on the stack. A recording that straddles midnight UTC would mix two days.
const periodEnds = new Set(
  Object.entries(responses)
    .filter(([key]) => key.includes("/dashboard?"))
    .map(([, r]) => r.body.period.to),
);
if (periodEnds.size !== 1) die(`the recording crossed midnight UTC (${[...periodEnds].join(", ")}); run it again`);
const [recordedDay] = periodEnds;
const kpis = responses["GET /metrics/dashboard?days=30&bucket=day"].body.kpis.length;
if (!kpis) die("the demo workspace has no KPIs; run the seed first");

// An answer is only worth replaying if it cites a source; "couldn't find anything" cites none.
const grounded = (r) => r.body?.citations?.some((c) => c.cited) === true;
const examples = exampleQuestions();
const answers = [];
const english = new Map();
for (const q of examples.filter((e) => e.locale === "en")) {
  const r = await required("POST", "/ask", { question: q.question });
  if (!grounded(r)) die(`"${q.question}" cites no demo document (${JSON.stringify(r.body.answer)}); are they indexed?`);
  english.set(q.key, { question: q.question, ...r });
  answers.push({ ...q, ...r });
}
// The demo documents are English. Without an LLM (LLM_PROVIDER=extractive, the compose default CI
// records with) an answer quotes the sentences that share words with the question, so a Russian or
// Arabic example finds nothing, or only a number coincidence ("1,000" vs "5,000"). Those examples replay
// the answer to their English version instead, and the preview labels them so.
for (const q of examples.filter((e) => e.locale !== "en")) {
  const en = english.get(q.key);
  if (en.body.provider !== "extractive") {
    const r = await required("POST", "/ask", { question: q.question });
    if (grounded(r)) {
      answers.push({ ...q, ...r });
      continue;
    }
  }
  console.log(`record-preview: ${q.locale} ${q.key} replays the answer to "${en.question}"`);
  answers.push({ ...q, status: en.status, body: en.body, answeredAs: en.question });
}

mkdirSync(OUT, { recursive: true });
const xlsx = await recordExport("xlsx");
const pdf = await recordExport("pdf");

const meta = {
  version: 1,
  recordedAt: new Date().toISOString(),
  recordedDay,
  source: API,
  demoEmail: me.body.email,
  tenantName: me.body.tenantName,
  exports: { ...EXPORT_VIEW, xlsx: xlsx.name, pdf: pdf.name },
};
writeFileSync(join(OUT, "responses.json"), `${JSON.stringify(responses, null, 1)}\n`);
writeFileSync(join(OUT, "ask.json"), `${JSON.stringify(answers, null, 1)}\n`);
writeFileSync(join(OUT, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

console.log(
  JSON.stringify({
    msg: "preview data recorded",
    out: OUT,
    recordedDay,
    kpis,
    documents,
    responses: Object.keys(responses).length,
    answers: answers.length,
    fromEnglish: answers.filter((a) => a.answeredAs).length,
    exports: { xlsx: xlsx.size, pdf: pdf.size },
  }),
);
