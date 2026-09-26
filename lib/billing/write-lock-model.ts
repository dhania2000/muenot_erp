/**
 * Spec46 (#118-120) — read-only grace mode / suspension write lock.
 * ---------------------------------------------------------------------------
 * Pure and edge-safe (no I/O): shared by the middleware gate, the internal
 * access-state feed and requireWriteAccess so every layer makes the same call.
 *
 * The authoritative lifecycle lives in `saas_subscriptions` (subscription
 * engine). The platform `tenant_subscriptions` row only knows
 * trialing/active/past_due/canceled and can never express `grace`, so write
 * access is derived from the tenant's latest engine subscription, reconciled
 * to "now" so the lock applies even between cron sweeps.
 */
import {
  canWrite,
  isReadOnly,
  isRenewalMode,
  isSubscriptionStatus,
  isBillingTerm,
  normalizeLifecycleConfig,
  reconcileLifecycle,
  type SubscriptionStatus,
} from "@/lib/billing/subscription-lifecycle"

export const WRITE_LOCK_CODE = "SUBSCRIPTION_READ_ONLY"
export const WRITE_LOCK_STATUS = 423

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * APIs that must stay writable while a tenant is locked, otherwise a tenant in
 * grace could never pay, cancel, update billing contacts, sign out or switch
 * to a healthy organization.
 */
export const WRITE_LOCK_EXEMPT_PREFIXES = [
  "/api/billing",
  "/api/auth",
  "/api/maintenance",
  "/api/organizations/switch",
  "/api/platform",
  "/api/cron",
  "/api/health",
  "/api/status",
  "/api/public",
  "/api/portal",
  "/api/vendor-portal",
] as const

export function isMutatingMethod(method: string | null | undefined): boolean {
  return MUTATING_METHODS.has(String(method ?? "").toUpperCase())
}

export function isWriteLockExemptPath(pathname: string): boolean {
  return WRITE_LOCK_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Whether the middleware should consult the tenant's write state for this
 * request. Platform staff are never locked: they operate on tenants in any
 * lifecycle state (support, recovery, reactivation).
 */
export function shouldCheckWriteLock(input: {
  method: string
  pathname: string
  platformRole?: string | null
}): boolean {
  if (!input.pathname.startsWith("/api/")) return false
  if (!isMutatingMethod(input.method)) return false
  if (isWriteLockExemptPath(input.pathname)) return false
  if (input.platformRole && input.platformRole !== "none") return false
  return true
}

export type WriteAccessState = {
  writable: boolean
  status: SubscriptionStatus | null
  reason: string | null
}

export const READ_ONLY_REASON =
  "Your subscription is past due and in read-only grace mode. Settle the outstanding balance to restore write access."
export const INACTIVE_REASON = "Your subscription is not active. Reactivate your plan to continue."

export function writeAccessFromStatus(status: SubscriptionStatus | null): WriteAccessState {
  if (status == null || canWrite(status)) return { writable: true, status, reason: null }
  if (isReadOnly(status)) return { writable: false, status, reason: READ_ONLY_REASON }
  return { writable: false, status, reason: INACTIVE_REASON }
}

/** Raw `saas_subscriptions` columns needed to position a row in its lifecycle. */
export type SubscriptionAccessRow = {
  status: unknown
  term: unknown
  auto_renew: unknown
  cancel_at_period_end: unknown
  renewal_mode?: unknown
  trial_end_date: unknown
  current_period_start: unknown
  current_period_end: unknown
  past_due_days?: unknown
  grace_days?: unknown
  suspend_days?: unknown
  last_payment_at?: unknown
}

function isoDate(v: unknown): string | null {
  if (v == null || v === "") return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function flag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || (typeof v === "object" && v != null && (v as any)[0] === 1)
}

/**
 * Write access for a tenant given its latest engine subscription row.
 *   • no row             → writable (tenant not on engine billing: starter floor)
 *   • malformed row      → writable (never lock a tenant out on bad data)
 *   • otherwise          → reconcile to `now`, then map status → access
 */
export function deriveWriteAccess(row: SubscriptionAccessRow | null | undefined, now: string): WriteAccessState {
  if (!row) return writeAccessFromStatus(null)
  const stored = isSubscriptionStatus(row.status) ? row.status : null
  const periodStart = isoDate(row.current_period_start)
  const periodEnd = isoDate(row.current_period_end)
  if (!stored || !periodStart || !periodEnd) return writeAccessFromStatus(stored)
  const result = reconcileLifecycle(
    {
      status: stored,
      term: isBillingTerm(row.term) ? row.term : "monthly",
      autoRenew: flag(row.auto_renew),
      cancelAtPeriodEnd: flag(row.cancel_at_period_end),
      trialEndDate: isoDate(row.trial_end_date),
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      config: normalizeLifecycleConfig({
        pastDueDays: row.past_due_days as number,
        graceDays: row.grace_days as number,
        suspendDays: row.suspend_days as number,
      }),
      renewalMode: isRenewalMode(row.renewal_mode) ? row.renewal_mode : "optimistic",
      lastPaymentAt: isoDate(row.last_payment_at),
    },
    now,
  )
  return writeAccessFromStatus(result.status)
}
