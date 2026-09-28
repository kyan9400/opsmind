// Shared helpers for the k6 scripts. Everything talks to the public API only,
// so the same scripts work against compose, CI and a deployed environment.
import http from "k6/http";
import { check, fail, sleep } from "k6";

export const BASE_URL = (__ENV.API || "http://localhost:4000").replace(/\/+$/, "");
export const API = `${BASE_URL}/api/v1`;

// Inline rather than open()ed so the scripts run from any working directory; the questions
// below are answerable from it, which keeps /ask on the retrieval + answer path.
export const POLICY_DOC = `Refund policy

Customers can request a full refund within 30 days of purchase.
After 30 days, only store credit is offered.

Shipping policy

Orders ship within 2 business days from our Kazan warehouse.
Express delivery is available in Moscow and Saint Petersburg.
`;

export const QUESTIONS = [
  "How many days do customers have to request a refund?",
  "What is offered after 30 days?",
  "How fast do orders ship?",
  "Where is the warehouse?",
  "Is express delivery available?",
];

export function authHeaders(token, extra = {}) {
  return { headers: { authorization: `Bearer ${token}` }, ...extra };
}

export function jsonHeaders(token, extra = {}) {
  return {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...extra,
  };
}

// Setup traffic gets its own tag so it never pollutes the per-endpoint numbers.
const SETUP = { tags: { name: "setup" } };

function must(res, what, status) {
  if (res.status !== status) {
    fail(`${what}: expected ${status}, got ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  return res;
}

/**
 * Creates a fresh tenant per run: numbers are never skewed by data left over
 * from earlier runs, and the run can't collide with real users.
 */
export function bootstrapTenant({ withDocument = true, indexTimeoutSec = 90 } = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const reg = must(
    http.post(
      `${API}/auth/register`,
      JSON.stringify({
        tenantName: `Load ${stamp}`,
        name: "Load Runner",
        email: `load-${stamp}@example.com`,
        password: "password123",
      }),
      { headers: { "content-type": "application/json" }, ...SETUP },
    ),
    "register",
    201,
  );
  const token = reg.json("token");
  if (!token) fail("register: no token in response");

  const demo = must(http.post(`${API}/metrics/demo`, null, authHeaders(token, SETUP)), "demo KPIs", 201);
  if (demo.json("imported.metrics") !== 6) fail(`demo KPIs: unexpected body ${demo.body}`);

  let documentId = null;
  if (withDocument) {
    const up = must(
      http.post(
        `${API}/documents`,
        { file: http.file(POLICY_DOC, "policies.txt", "text/plain") },
        authHeaders(token, SETUP),
      ),
      "upload",
      202,
    );
    documentId = up.json("id");
    waitForIndexed(token, documentId, indexTimeoutSec);
  }

  // Insights are computed by the AI service once and then served from Redis;
  // warming here means the test measures the steady state users actually see.
  must(http.get(`${API}/metrics/insights?days=30`, authHeaders(token, SETUP)), "warm insights", 200);

  return { token, documentId };
}

function waitForIndexed(token, id, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let status = "queued";
  while (Date.now() < deadline) {
    const res = must(http.get(`${API}/documents/${id}`, authHeaders(token, SETUP)), "document status", 200);
    status = res.json("status");
    if (status === "ready") return;
    if (status === "failed") fail(`document ${id} failed to index: ${res.json("error")}`);
    sleep(1);
  }
  fail(`document ${id} not indexed within ${timeoutSec}s (last status: ${status})`);
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Thin wrappers so smoke.js and load.js hit endpoints identically and share checks.
export const endpoints = {
  dashboard(token) {
    const res = http.get(`${API}/metrics/dashboard?days=30&bucket=week`, authHeaders(token, { tags: { name: "dashboard" } }));
    check(res, {
      "dashboard 200": (r) => r.status === 200,
      "dashboard has 6 kpis": (r) => r.status === 200 && r.json("kpis.#") === 6,
    });
    return res;
  },
  insights(token) {
    const res = http.get(`${API}/metrics/insights?days=30`, authHeaders(token, { tags: { name: "insights" } }));
    check(res, {
      "insights 200": (r) => r.status === 200,
      "insights has anomalies": (r) => r.status === 200 && Array.isArray(r.json("anomalies")),
    });
    return res;
  },
  ask(token) {
    const res = http.post(
      `${API}/ask`,
      JSON.stringify({ question: pick(QUESTIONS) }),
      jsonHeaders(token, { tags: { name: "ask" } }),
    );
    check(res, {
      "ask 200": (r) => r.status === 200,
      "ask has answer": (r) => r.status === 200 && typeof r.json("answer") === "string",
    });
    return res;
  },
  documents(token) {
    const res = http.get(`${API}/documents`, authHeaders(token, { tags: { name: "documents" } }));
    check(res, {
      "documents 200": (r) => r.status === 200,
      "documents is a list": (r) => r.status === 200 && Array.isArray(r.json("data")),
    });
    return res;
  },
  document(token, id) {
    const res = http.get(`${API}/documents/${id}`, authHeaders(token, { tags: { name: "document" } }));
    check(res, { "document ready": (r) => r.status === 200 && r.json("status") === "ready" });
    return res;
  },
  me(token) {
    const res = http.get(`${API}/auth/me`, authHeaders(token, { tags: { name: "me" } }));
    check(res, { "me 200": (r) => r.status === 200 });
    return res;
  },
};
