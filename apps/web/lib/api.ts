// An empty (or "/") NEXT_PUBLIC_API_URL means "same origin": calls go to /api/v1 on the web app's own host and
// the Next.js server proxies them to the API (API_INTERNAL_URL in next.config.mjs). `??`, not `||`,
// so that "" is kept instead of falling back to the local-dev default.
const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const apiUrl = (path: string) => `${BASE}/api/v1${path}`;
const TOKEN_KEY = "opsmind.token";

export const getToken = () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY));
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  // Interactive preview: answered in the browser from recorded responses, never over the network.
  // The test stays inline so webpack drops the mock and its fixtures from every other build.
  if (process.env.NEXT_PUBLIC_PREVIEW === "1") return (await import("./mock")).mockApi<T>(path, init, token);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      // Let the browser set the multipart boundary for FormData uploads.
      ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export type Role = "owner" | "admin" | "member" | "viewer";
export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string;
  tenantName: string;
  /** Set only for a temporary sandbox workspace: when it (and this session) ends. */
  expiresAt?: string | null;
}
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}
export type DocumentStatus = "queued" | "processing" | "ready" | "failed";
export interface DocumentItem {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
}
export interface Citation {
  n: number;
  documentId: string;
  title: string;
  chunkIndex: number;
  snippet: string;
  score: number;
  cited: boolean;
}
export interface AskResponse {
  answer: string;
  citations: Citation[];
  provider: string;
  ms: number;
  /** The standalone question the search ran with, when a follow-up was rewritten using the history. */
  retrievalQuery?: string;
}
/** One earlier exchange sent with a follow-up question (the API takes the last 4, 2,000 characters each). */
export interface AskTurn {
  question: string;
  answer: string;
}
export const ASK_HISTORY_TURNS = 4;
export const ASK_HISTORY_CHARS = 2000;

export type Bucket = "day" | "week" | "month";
export interface Kpi {
  id: string;
  key: string;
  name: string;
  unit: string;
  aggregation: "sum" | "avg";
  direction: "up" | "down";
  current: number | null;
  previous: number | null;
  deltaPct: number | null;
  series: { bucket: string; value: number; partial: boolean }[];
}
export interface DashboardData {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  bucket: Bucket;
  kpis: Kpi[];
}
export interface Anomaly {
  metricId: string;
  metric: string;
  unit: string;
  day: string;
  value: number;
  expected: number;
  deviationPct: number | null;
  z: number;
  severity: "medium" | "high";
  kind: "spike" | "drop";
  bad: boolean;
}
export interface InsightsData {
  anomalies: Anomaly[];
  summary: string;
  provider: string;
  ms: number;
}
export interface ImportResult {
  imported: { metrics: number; points: number };
  errorCount: number;
  errors: { line: number; message: string }[];
}

/** Authenticated file download (exports need the bearer token, so a plain link won't do). */
export async function download(path: string, fallbackName: string) {
  if (process.env.NEXT_PUBLIC_PREVIEW === "1") {
    // The preview ships its recorded exports as static files: link to them directly.
    const file = await (await import("./mock")).mockDownload(path);
    return save(file.url, file.name);
  }
  const token = getToken();
  const res = await fetch(apiUrl(path), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  save(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function save(href: string, name: string) {
  const a = Object.assign(document.createElement("a"), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

export const RANK: Role[] = ["viewer", "member", "admin", "owner"];
export const atLeast = (r: Role, min: Role) => RANK.indexOf(r) >= RANK.indexOf(min);

export interface AuditEvent {
  id: string;
  action: string;
  target: string | null;
  actorEmail: string | null;
  createdAt: string;
}
