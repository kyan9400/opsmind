import { api, sandboxExpiry } from "./api";

// The API's default SANDBOX_TTL_HOURS (apps/api/src/config.ts), which the live demo keeps: for the text that
// says how long a sandbox lasts before one exists. Once it does, /auth/me gives its real expiry.
export const SANDBOX_TTL_HOURS = 3;
// Its default upload limits for a sandbox, which the API enforces. The Documents page states them and checks a
// file against them before sending it, so a refusal comes first and in the visitor's language.
export const SANDBOX_MAX_FILE_BYTES = 512 * 1024;
export const SANDBOX_MAX_BYTES = 1024 * 1024;
/** A sandbox may re-index a document that failed, or one queued or processing for this long (API: STUCK_AFTER). */
export const SANDBOX_STUCK_MS = 15 * 60 * 1000;

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
