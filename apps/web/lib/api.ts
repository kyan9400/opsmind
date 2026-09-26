const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
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
  const res = await fetch(`${BASE}/api/v1${path}`, {
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
