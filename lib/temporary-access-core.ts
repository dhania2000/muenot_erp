// =============================================================
// SPEC 64 / 65 — Temporary & break-glass access (pure, testable core)
// -------------------------------------------------------------
// The scheduling and validation rules that drive automatic revocation and
// scheduled activation live here so they can be unit-tested without a
// database. The DB/enforcement layer lives in lib/temporary-access-store.ts,
// which imports these pure helpers. Kept free of any server-only imports.
// =============================================================

export const GRANT_KINDS = ["temporary", "break_glass"] as const
export type GrantKind = (typeof GRANT_KINDS)[number]

export const GRANT_STATUSES = ["pending", "active", "expired", "revoked", "rejected"] as const
export type GrantStatus = (typeof GRANT_STATUSES)[number]

/** Tenant roles that may be granted via a time-boxed elevation. Ownership is
 * deliberately excluded — it can never be conferred through temporary or
 * break-glass access (mirrors the impersonation cap in lib/role-model.ts). */
export const GRANTABLE_TENANT_ROLES = ["module_admin", "tenant_admin"] as const
export type GrantableTenantRole = (typeof GRANTABLE_TENANT_ROLES)[number]

export const MIN_DURATION_MINUTES = 5
export const MAX_DURATION_MINUTES = 60 * 24 * 30 // 30 days

export function isGrantKind(v: unknown): v is GrantKind {
  return typeof v === "string" && (GRANT_KINDS as readonly string[]).includes(v)
}

export function isGrantableTenantRole(v: unknown): v is GrantableTenantRole {
  return typeof v === "string" && (GRANTABLE_TENANT_ROLES as readonly string[]).includes(v)
}

/** A grant reduced to the fields the scheduler needs, using epoch-ms times. */
export type CoreGrant = {
  id: number
  kind: GrantKind
  status: GrantStatus
  startAt: number
  expiresAt: number
}

export type DueTransitions = {
  /** Pending TEMPORARY grants whose start time has arrived and are not past expiry. */
  toActivate: number[]
  /** Active grants (either kind) whose expiry has passed. */
  toExpire: number[]
}

/**
 * Decide which grants the scheduler must transition at `now`.
 *
 *  - Active grants past their expiry are revoked automatically (both kinds).
 *  - Pending TEMPORARY grants whose scheduled start has arrived are activated.
 *    Break-glass grants are never auto-activated: they require an explicit
 *    human approval step, so a pending break-glass request that is never
 *    approved simply lapses at its expiry with no elevation ever applied.
 */
export function computeDueTransitions(grants: readonly CoreGrant[], now: number): DueTransitions {
  const toActivate: number[] = []
  const toExpire: number[] = []
  for (const g of grants) {
    if (g.status === "active" && g.expiresAt <= now) {
      toExpire.push(g.id)
    } else if (g.status === "pending" && g.expiresAt <= now) {
      // A pending grant that was never activated before its own expiry is dead.
      toExpire.push(g.id)
    } else if (g.status === "pending" && g.kind === "temporary" && g.startAt <= now && g.expiresAt > now) {
      toActivate.push(g.id)
    }
  }
  return { toActivate, toExpire }
}

export function isGrantCurrentlyActive(g: CoreGrant, now: number): boolean {
  return g.status === "active" && g.startAt <= now && g.expiresAt > now
}

export type WindowValidation = { ok: true } | { ok: false; error: string }

/** Validate a [startAt, expiresAt] window against the duration policy. */
export function validateWindow(startAt: number, expiresAt: number, now: number): WindowValidation {
  if (!Number.isFinite(startAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, error: "A valid start and expiry time are required" }
  }
  if (expiresAt <= startAt) {
    return { ok: false, error: "Expiry must be after the start time" }
  }
  if (expiresAt <= now) {
    return { ok: false, error: "Expiry must be in the future" }
  }
  const durationMinutes = (expiresAt - startAt) / 60_000
  if (durationMinutes < MIN_DURATION_MINUTES) {
    return { ok: false, error: `Access must last at least ${MIN_DURATION_MINUTES} minutes` }
  }
  if (durationMinutes > MAX_DURATION_MINUTES) {
    return { ok: false, error: "Access window exceeds the maximum allowed duration (30 days)" }
  }
  return { ok: true }
}

export function clampDurationMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MIN_DURATION_MINUTES
  return Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, Math.round(minutes)))
}
