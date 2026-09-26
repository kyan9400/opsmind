export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** True when `actual` is at least as privileged as `required`. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** A user may only assign roles strictly below their own. */
export function canAssign(actor: Role, target: Role): boolean {
  return ROLES.indexOf(target) < ROLES.indexOf(actor);
}
