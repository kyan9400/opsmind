import { api, sandboxExpiry } from "./api";

/** True while the stored session is a sandbox that has not expired yet. */
export function liveSandbox(): boolean {
  const at = sandboxExpiry();
  return at !== null && Date.parse(at) > Date.now();
}

/**
 * Deletes the sandbox `token` belongs to, best effort: the visitor is leaving it, and one left behind still
 * expires on its own. Not awaited: the client-side navigation that follows leaves the request running.
 */
export function endSandbox(token: string | null) {
  if (!token) return;
  api("/sandbox", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
}
