/**
 * SPEC 16 — SaaS Subscription Engine: pure lifecycle model.
 * ---------------------------------------------------------------------------
 * This module contains ZERO database or IO code so the entire subscription
 * state machine is deterministic and unit-testable. The service layer
 * (lib/subscription-service.ts) and the background sweep both drive their
 * persisted transitions through `projectSubscription` here, so the UI, the
 * cron sweep, and the tests can never disagree about what a subscription's
 * status should be at a given moment.
 *
 * Billing cycles supported: Monthly, Yearly, 2-year, 5-year.
 * Lifecycle statuses: Trial → Active → Past due → Grace period →
 *                     Suspended / Cancelled / Expired.
 */

// ── Domain constants ─────────────────────────────────────────────────────────

export const BILLING_CYCLES = ["Monthly", "Yearly", "2-year", "5-year"] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export const SUBSCRIPTION_STATUSES = [
  "Trial",
  "Active",
  "Past due",
  "Grace period",
  "Suspended",
  "Cancelled",
  "Expired",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/** Statuses in which the customer still has service access. */
export const LIVE_STATUSES: SubscriptionStatus[] = ["Trial", "Active", "Past due", "Grace period"]

/** Terminal statuses — the sweep never moves a subscription out of these. */
export const TERMINAL_STATUSES: SubscriptionStatus[] = ["Cancelled", "Expired"]

/**
 * "Suspended" is a hold that only an explicit resume action can leave; the
 * sweep leaves it untouched (unlike the automatic dunning statuses).
 */
export const HOLD_STATUSES: SubscriptionStatus[] = ["Suspended"]

/**
 * Days after a period ends during which the subscription is "Past due"
 * (active dunning / payment-retry window) before it enters the grace period.
 */
export const PAST_DUE_DAYS = 3

/** Default courtesy-access window (days) after the past-due window elapses. */
export const DEFAULT_GRACE_DAYS = 7

/** Number of whole calendar months a single billing cycle spans. */
export function cycleMonths(cycle: BillingCycle): number {
  switch (cycle) {
    case "Monthly":
      return 1
    case "Yearly":
      return 12
    case "2-year":
      return 24
    case "5-year":
      return 60
    default:
      return 1
  }
}

// ── Date helpers (UTC, ISO yyyy-mm-dd) ────────────────────────────────────────

const MS_PER_DAY = 86_400_000

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseISO(dateStr: string): Date {
  return new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`)
}

/** Whole days from `from` to `to` (negative when `to` is before `from`). */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = parseISO(fromISO).getTime()
  const b = parseISO(toISO).getTime()
  return Math.round((b - a) / MS_PER_DAY)
}

/**
 * Advance a date by one billing cycle, clamping the day-of-month so month
 * arithmetic never rolls over (e.g. Jan 31 + 1 month → Feb 28/29).
 */
export function addCycle(dateISO: string, cycle: BillingCycle): string {
  const d = parseISO(dateISO)
  const day = d.getUTCDate()
  const target = new Date(d)
  target.setUTCDate(1)
  target.setUTCMonth(target.getUTCMonth() + cycleMonths(cycle))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return toISODate(target)
}

// ── Cost normalisation (for MRR / ARR analytics) ─────────────────────────────

/** Amount normalised to a monthly figure for the given cycle. */
export function monthlyAmount(amount: number, cycle: BillingCycle): number {
  return amount / cycleMonths(cycle)
}

/** Amount normalised to an annual figure for the given cycle. */
export function annualAmount(amount: number, cycle: BillingCycle): number {
  return monthlyAmount(amount, cycle) * 12
}

// ── Lifecycle state machine ───────────────────────────────────────────────────

export interface ProjectionInput {
  /** The currently stored lifecycle status. */
  status: SubscriptionStatus
  /**
   * End of the current paid (or trial) period, ISO date. For a trialing
   * subscription this is the trial end date.
   */
  currentPeriodEnd: string
  cycle: BillingCycle
  autoRenew: boolean
  /** When true the subscription is scheduled to cancel at period end. */
  cancelAtPeriodEnd: boolean
  /** Courtesy-access days after the past-due window. */
  graceDays: number
  /**
   * Whether the automatic renewal payment can be collected. The engine itself
   * does not talk to a gateway; the service layer passes the real result. When
   * false, an auto-renew subscription falls through the dunning windows instead
   * of renewing.
   */
  paymentOk: boolean
  /**
   * Optional hard end of the overall contract term. The subscription never
   * renews past this date and becomes Expired once reached. Null = renews
   * indefinitely while auto-renew and payment hold.
   */
  termEndDate?: string | null
}

export interface Projection {
  status: SubscriptionStatus
  currentPeriodEnd: string
  /** How many automatic renewals were applied to reach `now`. */
  renewalsApplied: number
  /** True when a trial was converted into its first paid period. */
  convertedFromTrial: boolean
}

/**
 * Compute what a subscription's status and period end SHOULD be at `nowISO`,
 * given its stored state. Pure and idempotent: calling it repeatedly with the
 * same inputs yields the same result, and feeding its own output back in is a
 * fixed point. This is the single source of truth for every lifecycle
 * transition in the system.
 */
export function projectSubscription(input: ProjectionInput, nowISO: string): Projection {
  const now = parseISO(nowISO)
  const stable = (status: SubscriptionStatus): Projection => ({
    status,
    currentPeriodEnd: input.currentPeriodEnd,
    renewalsApplied: 0,
    convertedFromTrial: false,
  })

  // Terminal and hold states never change without an explicit action.
  if (TERMINAL_STATUSES.includes(input.status)) return stable(input.status)
  if (HOLD_STATUSES.includes(input.status)) return stable(input.status)

  const graceDays = Number.isFinite(input.graceDays) ? Math.max(0, input.graceDays) : DEFAULT_GRACE_DAYS
  let periodEnd = input.currentPeriodEnd
  let renewalsApplied = 0
  let convertedFromTrial = false

  // 1. Trial phase.
  if (input.status === "Trial") {
    if (now < parseISO(periodEnd)) return stable("Trial")
    // Trial has ended.
    if (input.cancelAtPeriodEnd) {
      return { status: "Cancelled", currentPeriodEnd: periodEnd, renewalsApplied: 0, convertedFromTrial: false }
    }
    if (input.autoRenew && input.paymentOk) {
      // Convert to the first paid period starting at trial end.
      periodEnd = addCycle(periodEnd, input.cycle)
      convertedFromTrial = true
    }
    // If it cannot convert, `periodEnd` stays at the trial end and the dunning
    // window classification below applies.
  }

  const withinTerm = (dateISO: string) => !input.termEndDate || dateISO <= input.termEndDate

  // 2. Automatic renewal loop for renewable subscriptions.
  if (input.autoRenew && input.paymentOk && !input.cancelAtPeriodEnd) {
    while (now >= parseISO(periodEnd)) {
      const next = addCycle(periodEnd, input.cycle)
      if (!withinTerm(next)) break // would exceed the contracted term
      periodEnd = next
      renewalsApplied++
    }
    if (now < parseISO(periodEnd)) {
      return { status: "Active", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
    }
    // Loop exited because the term cap was reached.
    return { status: "Expired", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
  }

  // 3. Non-renewing (or payment-failing, or cancel-at-period-end) path.
  if (now < parseISO(periodEnd)) {
    return { status: "Active", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
  }

  // The current period has ended without a renewal.
  if (input.cancelAtPeriodEnd) {
    return { status: "Cancelled", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
  }

  const daysOver = daysBetween(periodEnd, nowISO)
  if (daysOver <= PAST_DUE_DAYS) {
    return { status: "Past due", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
  }
  if (daysOver <= PAST_DUE_DAYS + graceDays) {
    return { status: "Grace period", currentPeriodEnd: periodEnd, renewalsApplied, convertedFromTrial }
  }
  // Grace exhausted: an auto-renew subscription whose payment kept failing is
  // suspended (recoverable on payment); a plain non-renewing term simply
  // expires.
  return {
    status: input.autoRenew ? "Suspended" : "Expired",
    currentPeriodEnd: periodEnd,
    renewalsApplied,
    convertedFromTrial,
  }
}

/**
 * The period end that a manual renewal should extend from: whichever is later
 * of the existing period end or today, so renewing an already-lapsed
 * subscription starts a fresh full period from now rather than in the past.
 */
export function renewalBaseDate(currentPeriodEnd: string, nowISO: string): string {
  return currentPeriodEnd >= nowISO ? currentPeriodEnd : nowISO
}
