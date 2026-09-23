/**
 * User lifecycle: the PURE state model.
 * ---------------------------------------------------------------------------
 * This module is deliberately free of any I/O (no DB, no `server-only`) so the
 * whole joiner / mover / leaver decision surface is unit-testable in isolation
 * — the same split uses (lib/sod-core.ts is the pure engine, lib/sod.ts
 * is the DB layer). lib/user-lifecycle.ts is the DB layer that drives these
 * rules; the login route consumes `evaluateLogin` as the single gate.
 *
 * A user moves through four durable lifecycle states:
 *
 *   invited ──accept──▶ active ──suspend──▶ suspended
 *      │                  │  ▲                 │
 *      │revoke            │  └────reactivate───┘
 *      ▼                  ▼
 *   deactivated ◀──deactivate (offboard) from active OR suspended
 *      │
 *      └──reactivate (rehire)──▶ active
 *
 * `status` (the legacy ENUM('active','inactive') the login query already reads)
 * is kept as a derived mirror: only `active` lifecycle maps to status=active.
 * Temporary access adds a time bound on top of an otherwise `active` user.
 */

export const LIFECYCLE_STATES = ["invited", "active", "suspended", "deactivated"] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

export function isLifecycleState(v: unknown): v is LifecycleState {
  return typeof v === "string" && (LIFECYCLE_STATES as readonly string[]).includes(v)
}

/**
 * The allowed lifecycle transitions. A transition not listed here is refused by
 * `canTransition`, which is what stops nonsensical moves (e.g. re-inviting an
 * already-active user, or suspending someone who was offboarded).
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  invited: ["active", "deactivated"],
  active: ["suspended", "deactivated"],
  suspended: ["active", "deactivated"],
  deactivated: ["active"],
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * The lifecycle actions an operator (or the user) can take. The transitioning
 * ones map to a target state via `targetStateForAction`; the rest
 * (assign_role, assign_department, transfer_ownership, password/MFA) mutate a
 * user without changing their lifecycle state and are always allowed on a user
 * that is not deactivated (enforced in the DB layer).
 */
export const LIFECYCLE_ACTIONS = [
  "invite",
  "activate",
  "verify_email",
  "suspend",
  "reactivate",
  "grant_temp_access",
  "revoke_temp_access",
  "deactivate",
  "rehire",
  "assign_role",
  "assign_department",
  "transfer_ownership",
  "reset_password",
  "enroll_mfa",
  "disable_mfa",
  "reset_mfa",
] as const
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

/** The lifecycle state an action drives to, or null when it does not move state. */
export function targetStateForAction(action: LifecycleAction): LifecycleState | null {
  switch (action) {
    case "invite":
      return "invited"
    case "activate":
    case "reactivate":
    case "rehire":
      return "active"
    case "suspend":
      return "suspended"
    case "deactivate":
      return "deactivated"
    default:
      return null
  }
}

/**
 * Validate a state-moving action against the current state. Non-transitioning
 * actions are always structurally valid here (their own guards live in the DB
 * layer). Returns a machine-usable reason on rejection.
 */
export function validateAction(
  action: LifecycleAction,
  from: LifecycleState,
): { ok: true; to: LifecycleState | null } | { ok: false; reason: string } {
  const to = targetStateForAction(action)
  if (to == null) return { ok: true, to: null }
  if (from === to) {
    return { ok: false, reason: `User is already ${from}` }
  }
  if (!canTransition(from, to)) {
    return { ok: false, reason: `Cannot ${action} a user that is ${from}` }
  }
  return { ok: true, to }
}

// ---------------------------------------------------------------------------
// Login evaluation — the single gate the auth route calls
// ---------------------------------------------------------------------------

export type UserLifecycleSnapshot = {
  lifecycleState: LifecycleState
  /** ISO string / Date / null. When set and in the future the account is time-bound. */
  accessExpiresAt: string | Date | null
  emailVerifiedAt: string | Date | null
  mfaEnabled: boolean
  /** Tenant policy: block unverified emails from signing in. Default false. */
  requireEmailVerification?: boolean
}

export type LoginBlockCode =
  | "invited"
  | "suspended"
  | "deactivated"
  | "temp_access_expired"
  | "email_unverified"

export type LoginDecision =
  | { allowed: true; requiresMfa: boolean }
  | { allowed: false; code: LoginBlockCode; reason: string }

function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  const t = d.getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * The authoritative "can this user start a session right now?" decision.
 * Factors the durable lifecycle state, a temporary-access expiry, and the
 * email-verification policy, and reports whether an MFA challenge is still
 * owed. Pure so it is fully covered by the joiner/mover/leaver tests.
 */
export function evaluateLogin(snapshot: UserLifecycleSnapshot, now: Date = new Date()): LoginDecision {
  switch (snapshot.lifecycleState) {
    case "invited":
      return {
        allowed: false,
        code: "invited",
        reason: "Your invitation has not been accepted yet. Check your email to finish setting up your account.",
      }
    case "suspended":
      return { allowed: false, code: "suspended", reason: "This account is suspended. Contact your administrator." }
    case "deactivated":
      return { allowed: false, code: "deactivated", reason: "This account has been deactivated." }
    case "active":
      break
  }

  // Time-bound (temporary) access: an expiry in the past blocks login exactly
  // like a suspension, without any background job needing to flip the state.
  const expires = toMs(snapshot.accessExpiresAt)
  if (expires != null && expires <= now.getTime()) {
    return {
      allowed: false,
      code: "temp_access_expired",
      reason: "Your temporary access has expired. Contact your administrator to extend it.",
    }
  }

  if (snapshot.requireEmailVerification && toMs(snapshot.emailVerifiedAt) == null) {
    return {
      allowed: false,
      code: "email_unverified",
      reason: "Please verify your email address before signing in.",
    }
  }

  return { allowed: true, requiresMfa: Boolean(snapshot.mfaEnabled) }
}

/**
 * Derive the legacy `users.status` ENUM value from a lifecycle state, so the
 * two representations never drift. Only a genuinely active user is `active`.
 */
export function statusForLifecycle(state: LifecycleState): "active" | "inactive" {
  return state === "active" ? "active" : "inactive"
}
