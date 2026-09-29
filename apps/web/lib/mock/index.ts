import answers from "@preview-data/ask.json";
import pdfUrl from "@preview-data/export.pdf";
import xlsxUrl from "@preview-data/export.xlsx";
import meta from "@preview-data/meta.json";
import responses from "@preview-data/responses.json";
import { ApiError, type AskResponse, type DashboardData, type InsightsData } from "../api";
import { DEFAULT_LOCALE, isLocale } from "../i18n/config";
import { createTranslator } from "../i18n/translate";
import { createShifter, todayUtc } from "./shift";
import type { Recorded } from "./types";

/**
 * The interactive preview's "API": answers api() and download() in the browser from responses
 * recorded on the real stack (scripts/record-preview.mjs). No network and no Service Worker, which a
 * static host may block. Reads replay the recording; writes get a translated "preview only" notice.
 */

const DEMO_EMAIL = process.env.NEXT_PUBLIC_DEMO_EMAIL ?? "";
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? "";

/** Not a JWT: nothing verifies it. It only lets the pages' own "401 -> /login" handling work. */
const PREVIEW_TOKEN = "preview-demo-session";

// Notices follow the UI language; the i18n provider keeps <html lang> in sync with it.
function translator() {
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  return createTranslator(isLocale(lang) ? lang : DEFAULT_LOCALE);
}

function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}

/** A recorded response as the API gave it, errors included (e.g. the viewer's 403 on /audit). */
function replay<T>(r: Recorded | undefined): T {
  if (!r) fail(404, translator()("preview.notRecorded"));
  if (r.status >= 400) fail(r.status, (r.body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return structuredClone(r.body) as T;
}

/** The recording for the closest period (and the same bucket when there is one). */
function nearest(route: string, days: number, bucket?: string): Recorded | undefined {
  let best: { key: string; score: number } | undefined;
  for (const key of Object.keys(responses)) {
    const [path, query = ""] = key.split("?");
    if (path !== `GET ${route}`) continue;
    const q = new URLSearchParams(query);
    const score = Math.abs(Number(q.get("days")) - days) + (bucket && q.get("bucket") !== bucket ? 1000 : 0);
    if (!best || score < best.score) best = { key, score };
  }
  return best && responses[best.key];
}

const byRoute = (route: string) => Object.keys(responses).find((k) => k.split("?")[0] === `GET ${route}`);

// Example questions match whatever the UI language or punctuation: "$1,000?" and "$1000" are the same.
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{P}\p{S}\p{Mn}ـ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function parseBody(body: RequestInit["body"]): Record<string, string> {
  try {
    return typeof body === "string" ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

function ask(question = ""): AskResponse {
  const t = translator();
  const q = normalize(question);
  const hit = q ? answers.find((a) => normalize(a.question) === q) : undefined;
  if (!hit) return { answer: t("preview.askOnly"), citations: [], provider: t("preview.noAnswer"), ms: 0 };
  const r = replay<AskResponse>(hit);
  return { ...r, provider: t(hit.answeredAs ? "preview.englishAnswer" : "preview.recordedAnswer", { provider: r.provider }) };
}

export async function mockApi<T>(path: string, init: RequestInit, token: string | null): Promise<T> {
  const t = translator();
  const method = (init.method ?? "GET").toUpperCase();
  const url = new URL(path, "http://preview.invalid");
  const route = url.pathname;

  if (method === "POST" && route === "/auth/login") {
    const { email = "", password = "" } = parseBody(init.body);
    if (DEMO_EMAIL && email.trim().toLowerCase() === DEMO_EMAIL.toLowerCase() && password === DEMO_PASSWORD) {
      return { token: PREVIEW_TOKEN } as T;
    }
    fail(401, t("preview.demoOnly"));
  }
  if (route === "/auth/register") fail(403, t("preview.readOnly"));
  // As on the real API, everything else needs a session.
  if (token !== PREVIEW_TOKEN) fail(401, "missing bearer token");
  if (method === "POST" && route === "/ask") return ask(parseBody(init.body).question) as T;
  if (method !== "GET") fail(403, t("preview.readOnly"));

  const shift = createShifter(meta.recordedDay, todayUtc());
  const times = <R extends Record<string, unknown>>(row: R): R => {
    const out: Record<string, unknown> = { ...row };
    for (const k of ["createdAt", "updatedAt", "nextBefore"]) if (typeof out[k] === "string") out[k] = shift.time(out[k]);
    return out as R;
  };
  const days = Number(url.searchParams.get("days") ?? 30);

  if (route === "/metrics/dashboard") {
    const bucket = url.searchParams.get("bucket") ?? "day";
    return shift.dashboard(replay<DashboardData>(nearest(route, days, bucket))) as T;
  }
  if (route === "/metrics/insights") return shift.insights(replay<InsightsData>(nearest(route, days))) as T;

  const docId = /^\/documents\/([^/]+)$/.exec(route)?.[1];
  if (docId) {
    const doc = replay<{ data: { id: string }[] }>(responses["GET /documents"]).data.find((d) => d.id === docId);
    return doc ? (times(doc) as T) : fail(404, "document not found");
  }

  const r = replay<{ data?: Record<string, unknown>[] }>(responses[`GET ${route}${url.search}`] ?? responses[byRoute(route) ?? ""]);
  return (Array.isArray(r.data) ? times({ ...r, data: r.data.map(times) }) : r) as T;
}

/** The recorded exports ship with the site as static files; other views get a notice instead. */
export async function mockDownload(path: string): Promise<{ url: string; name: string }> {
  const q = new URL(path, "http://preview.invalid").searchParams;
  const { days, bucket, xlsx, pdf } = meta.exports;
  const format = q.get("format");
  if (Number(q.get("days")) !== days || q.get("bucket") !== bucket || (format !== "xlsx" && format !== "pdf")) {
    const t = translator();
    fail(409, t("preview.exportOnly", { range: t("analytics.range", { count: days }) }));
  }
  return format === "xlsx" ? { url: xlsxUrl, name: xlsx } : { url: pdfUrl, name: pdf };
}
