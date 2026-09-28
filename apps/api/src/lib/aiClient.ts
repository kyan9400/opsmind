import { config } from "../config.js";
import { HttpError } from "./errors.js";

/** Calls the internal Python AI service. Tenant scoping is always passed from the verified token. */
export async function aiPost<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(`${config.AI_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": config.AI_SERVICE_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, "AI service unavailable");
  }
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}
