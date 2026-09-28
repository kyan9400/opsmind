import { expect, request, type APIRequestContext, type Page } from "@playwright/test";

export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const PASSWORD = "e2e-password-123";

// Must match apps/web/lib/api.ts: the web app keeps its JWT in localStorage under this key.
const TOKEN_KEY = "opsmind.token";

/** Unique per test and per retry, so reruns never collide with an account left by an earlier attempt. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export interface Account {
  email: string;
  password: string;
  name: string;
  tenantName: string;
  token: string;
}

export async function apiContext(token?: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: `${API_URL}/api/v1/`,
    extraHTTPHeaders: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Creates a fresh tenant and its owner through the API (faster than the UI for tests that are not about sign-up). */
export async function registerOwner(prefix: string, tenantName = `${prefix} Co`): Promise<Account> {
  const api = await apiContext();
  const account = { email: uniqueEmail(prefix), password: PASSWORD, name: `${prefix} Owner`, tenantName };
  const res = await api.post("auth/register", { data: account });
  expect(res.status(), await res.text()).toBe(201);
  const { token } = await res.json();
  await api.dispose();
  return { ...account, token };
}

export async function createUser(
  owner: Account,
  role: "admin" | "member" | "viewer",
  prefix: string = role,
): Promise<Omit<Account, "token">> {
  const api = await apiContext(owner.token);
  const user = { email: uniqueEmail(prefix), password: PASSWORD, name: `${prefix} User`, role };
  const res = await api.post("users", { data: user });
  expect(res.status(), await res.text()).toBe(201);
  await api.dispose();
  return { email: user.email, password: user.password, name: user.name, tenantName: owner.tenantName };
}

export async function loadDemoKpis(owner: Account): Promise<void> {
  const api = await apiContext(owner.token);
  const res = await api.post("metrics/demo");
  expect(res.ok(), await res.text()).toBe(true);
  await api.dispose();
}

/** Uploads text documents and waits until the worker has indexed every one of them. */
export async function uploadDocuments(owner: Account, docs: { filename: string; body: string }[]): Promise<void> {
  const api = await apiContext(owner.token);
  const ids: string[] = [];
  for (const d of docs) {
    const res = await api.post("documents", {
      multipart: { file: { name: d.filename, mimeType: "text/plain", buffer: Buffer.from(d.body, "utf8") } },
    });
    expect(res.status(), await res.text()).toBe(202);
    ids.push((await res.json()).id);
  }
  for (const id of ids) {
    await expect
      .poll(async () => (await (await api.get(`documents/${id}`)).json()).status, { timeout: 60_000, intervals: [500, 1000] })
      .toBe("ready");
  }
  await api.dispose();
}

/** Signs the page in without the login form: the token is in localStorage before any app script runs. */
export async function useToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [TOKEN_KEY, token] as const);
}

export async function readToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
}
