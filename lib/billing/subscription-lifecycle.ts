/**
 * SaaS subscription lifecycle (pure, dependency-free core).
 * ---------------------------------------------------------------------------
 * All date math and state-machine logic for the subscription engine lives here
 * as pure functions so it can be unit-tested without a database or a request
 * context (see test/subscription-engine.test.ts). The DB-backed service in
 * lib/billing/subscription-engine.ts composes these to read, mutate and
 * reconcile subscriptions.
 *
 * Lifecycle (ordered):
 *   trial → active → past_due → grace → suspended → expired
 *                         └──────── recover via payment/renewal ──────┘ (→ active)
 *   active/trial → cancelled (terminal, honoured immediately or at period end)
 *
 * Billing terms sold by Muenot: monthly, yearly, 2-year, 5-year.
 */

// ── Terms ────────────────────────────────────────────────────────────────────

export const BILLING_TERMS = ["monthly", "yearly", "two_year", "five_year"] as const
export type BillingTerm = (typeof BILLING_TERMS)[number]

export const TERM_LABELS: Record<BillingTerm, string> = {
  monthly: "Monthly",
  yearly: "Yearly",
  two_year: "2-Year",
  five_year: "5-Year",
}

/** Number of whole calendar months in one billing term. */
export function termMonths(term: BillingTerm): number {
  switch (term) {
    case "monthly":
      return 1
    case "yearly":
      return 12
    case "two_year":
      return 24
    case "five_year":
      return 60
  }
}

export function isBillingTerm(v: unknown): v is BillingTerm {
  return typeof v === "string" && (BILLING_TERMS as readonly string[]).includes(v)
}

// ── Statuses ───────────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES = [
  "trial",
  "active",
  "past_due",
  "grace",
  "suspended",
  "cancelled",
  "expired",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trial: "Trial",
  active: "Active",
  past_due: "Past due",
  grace: "Grace period",
  suspended: "Suspended",
  cancelled: "Cancelled",
  expired: "Expired",
}

/** Terminal statuses never transition on their own. */
export const TERMINAL_STATUSES: SubscriptionStatus[] = ["cancelled", "expired"]

/** Statuses in which the tenant still has working access to the product. */
export const ACTIVE_ACCESS_STATUSES: SubscriptionStatus[] = ["trial", "active", "past_due", "grace"]

export function isTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function hasProductAccess(status: SubscriptionStatus): boolean {
  return ACTIVE_ACCESS_STATUSES.includes(status)
}

export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return typeof v === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(v)
}

// ── Dunning windows ──────────────────────────────────────────────────────────

/**
 * Days spent in each recovery phase once a billing period ends without a
 * successful renewal. Sequential and additive from the period-end date:
 *   [end,                       end+pastDue)         → past_due
 *   [end+pastDue,               end+pastDue+grace)   → grace
 *   [end+pastDue+grace,         + suspend)           → suspended
 *   beyond                                            → expired
 */
export type LifecycleConfig = {
  pastDueDays: number
  graceDays: number
  suspendDays: number
}

export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  pastDueDays: 7,
  graceDays: 14,
  suspendDays: 30,
}

export function normalizeLifecycleConfig(cfg: Partial<LifecycleConfig> | null | undefined): LifecycleConfig {
  const clamp = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
  }
  return {
    pastDueDays: clamp(cfg?.pastDueDays, DEFAULT_LIFECYCLE.pastDueDays),
    graceDays: clamp(cfg?.graceDays, DEFAULT_LIFECYCLE.graceDays),
    suspendDays: clamp(cfg?.suspendDays, DEFAULT_LIFECYCLE.suspendDays),
  }
}

// ── Date helpers (UTC, ISO yyyy-mm-dd) ─────────────────────────────────────────

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function parseISODate(dateStr: string): Date {
  return new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`)
}

/** Add whole calendar months, clamping to the end of the target month. */
export function addMonths(dateStr: string, months: number): string {
  const d = parseISODate(dateStr)
  const day = d.getUTCDate()
  const target = new Date(d)
  target.setUTCDate(1)
  target.setUTCMonth(target.getUTCMonth() + months)
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(day, daysInTargetMonth))
  return toISODate(target)
}

export function addDays(dateStr: string, days: number): string {
  const d = parseISODate(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return toISODate(d)
}

/** Advance a date by exactly one billing term. */
export function addTerm(dateStr: string, term: BillingTerm): string {
  return addMonths(dateStr, termMonths(term))
}

/** Whole days from `from` to `to` (negative when `to` is before `from`). */
export function daysBetween(fromStr: string, toStr: string): number {
  const a = parseISODate(fromStr).getTime()
  const b = parseISODate(toStr).getTime()
  return Math.round((b - a) / 86_400_000)
}

// ── Dunning + status derivation ────────────────────────────────────────────

export type DunningPhase = "current" | "past_due" | "grace" | "suspended" | "expired"

/**
 * Which recovery phase applies at `now` for a billing period that ended on
 * `dueDate` and was not renewed/paid. Pure and total.
 */
export function dunningPhase(dueDate: string, now: string, cfg: LifecycleConfig): DunningPhase {
  const elapsed = daysBetween(dueDate, now)
  if (elapsed < 0) return "current"
  if (elapsed < cfg.pastDueDays) return "past_due"
  if (elapsed < cfg.pastDueDays + cfg.graceDays) return "grace"
  if (elapsed < cfg.pastDueDays + cfg.graceDays + cfg.suspendDays) return "suspended"
  return "expired"
}

export type LifecycleState = {
  /** Fields the engine reads to decide the current lifecycle position. */
  status: SubscriptionStatus
  term: BillingTerm
  autoRenew: boolean
  cancelAtPeriodEnd: boolean
  trialEndDate: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  config: LifecycleConfig
}

export type ReconcileResult = {
  status: SubscriptionStatus
  currentPeriodStart: string
  currentPeriodEnd: string
  /** Number of automatic renewals applied while catching the record up to `now`. */
  renewalsApplied: number
  changed: boolean
}

/**
 * Deterministically bring a subscription's lifecycle position up to date as of
 * `now`. This is the heart of the engine and drives both on-read refresh and
 * the daily cron sweep.
 *
 * Rules:
 *  - Terminal (cancelled/expired) records never change.
 *  - Inside the trial window → `trial`.
 *  - `auto_renew` (and not cancel-at-period-end) rolls the paid period forward
 *    one term at a time for every period that has fully elapsed, keeping the
 *    subscription `active` (models a successful automatic charge).
 *  - Otherwise, once the current period ends the record walks the dunning
 *    ladder past_due → grace → suspended → expired based on elapsed days.
 *  - `cancel_at_period_end` finalises to `cancelled` at period end.
 */
export function reconcileLifecycle(state: LifecycleState, now: string): ReconcileResult {
  const base: ReconcileResult = {
    status: state.status,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
    renewalsApplied: 0,
    changed: false,
  }

  if (isTerminal(state.status)) return base

  // Trial phase — access continues until the trial end date.
  if (state.trialEndDate && daysBetween(now, state.trialEndDate) > 0) {
    const changed = state.status !== "trial"
    return { ...base, status: "trial", changed }
  }

  let periodStart = state.currentPeriodStart
  let periodEnd = state.currentPeriodEnd
  let renewals = 0

  // Auto-renew rolls the period forward for each fully elapsed cycle.
  if (state.autoRenew && !state.cancelAtPeriodEnd) {
    // Guard against runaway loops on malformed data (max 240 cycles = 20yr monthly).
    let safety = 240
    while (daysBetween(periodEnd, now) >= 0 && safety-- > 0) {
      periodStart = periodEnd
      periodEnd = addTerm(periodEnd, state.term)
      renewals++
    }
    if (renewals > 0) {
      return {
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        renewalsApplied: renewals,
        changed: true,
      }
    }
    // Still within the current paid period.
    const changed = state.status !== "active"
    return { ...base, status: "active", changed }
  }

  // Not yet at period end → active (or still trial-converted active).
  if (daysBetween(periodEnd, now) < 0) {
    const changed = state.status !== "active"
    return { ...base, status: "active", changed }
  }

  // Period ended.
  if (state.cancelAtPeriodEnd) {
    return { ...base, status: "cancelled", changed: state.status !== "cancelled" }
  }

  const phase = dunningPhase(periodEnd, now, state.config)
  const mapped: SubscriptionStatus =
    phase === "current" ? "active" : (phase as SubscriptionStatus)
  return { ...base, status: mapped, changed: state.status !== mapped }
}
