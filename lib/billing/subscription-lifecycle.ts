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
 * Billing terms sold by Muenot: monthly, yearly, 2-year, 5-year, enterprise.
 *
 * "enterprise" is a negotiated annual contract: it bills on a 12-month cadence
 * (so the dunning/renewal math is identical to `yearly`) but carries its own
 * custom, per-plan price rather than one of the published list prices.
 */

// ── Terms ────────────────────────────────────────────────────────────────────

export const BILLING_TERMS = ["monthly", "yearly", "two_year", "five_year", "enterprise"] as const
export type BillingTerm = (typeof BILLING_TERMS)[number]

export const TERM_LABELS: Record<BillingTerm, string> = {
  monthly: "Monthly",
  yearly: "Yearly",
  two_year: "2-Year",
  five_year: "5-Year",
  enterprise: "Enterprise",
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
    case "enterprise":
      // Negotiated annual contract — same 12-month cadence, custom pricing.
      return 12
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

/**
 * Statuses in which the tenant may perform mutating (write) actions. `grace` is
 * deliberately excluded: during the grace window the product is READ-ONLY — the
 * tenant can still sign in and view/export their data, but every create/update/
 * delete is refused until they settle payment. `past_due` still allows writes
 * (the first, softest dunning phase); `grace` is the hard read-only tier before
 * suspension removes access entirely.
 */
export const WRITE_ACCESS_STATUSES: SubscriptionStatus[] = ["trial", "active", "past_due"]

/** Statuses that keep access but restrict the tenant to read-only usage. */
export const READ_ONLY_STATUSES: SubscriptionStatus[] = ["grace"]

export function isTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function hasProductAccess(status: SubscriptionStatus): boolean {
  return ACTIVE_ACCESS_STATUSES.includes(status)
}

/** True when the tenant may perform write/mutation actions in this status. */
export function canWrite(status: SubscriptionStatus): boolean {
  return WRITE_ACCESS_STATUSES.includes(status)
}

/**
 * True when the tenant retains access but is confined to read-only usage
 * (the grace period). Callers use this to allow GETs while refusing mutations.
 */
export function isReadOnly(status: SubscriptionStatus): boolean {
  return READ_ONLY_STATUSES.includes(status)
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
  /**
   * How auto-renewal is modelled:
   *  - "optimistic" (legacy default): auto_renew rolls the period forward on
   *    read, assuming the charge succeeded.
   *  - "charge_required": the period only moves forward after a recorded
   *    collection (renewal engine / manual payment). An uncollected period end
   *    walks the dunning ladder, so a FAILED renewal reaches grace/suspension.
   */
  renewalMode?: RenewalMode
  /** Last successful collection; null means the trial was never paid for. */
  lastPaymentAt?: string | null
}

export const RENEWAL_MODES = ["optimistic", "charge_required"] as const
export type RenewalMode = (typeof RENEWAL_MODES)[number]

export function isRenewalMode(v: unknown): v is RenewalMode {
  return typeof v === "string" && (RENEWAL_MODES as readonly string[]).includes(v)
}

/**
 * Date the current, still-unpaid obligation fell due. In charge-required mode
 * an ended trial that was never paid is due on the trial end date (its first
 * paid period starts there); otherwise the obligation is the period end.
 */
export function billingDueDate(state: Pick<LifecycleState, "trialEndDate" | "currentPeriodEnd" | "lastPaymentAt" | "renewalMode">): string {
  if (state.renewalMode === "charge_required" && state.trialEndDate && !state.lastPaymentAt) {
    return state.trialEndDate
  }
  return state.currentPeriodEnd
}

/** True when a charge-required trial has ended without the first payment. */
export function isUnpaidTrialConversion(
  state: Pick<LifecycleState, "trialEndDate" | "lastPaymentAt" | "renewalMode">,
  now: string,
): boolean {
  return (
    state.renewalMode === "charge_required" &&
    !!state.trialEndDate &&
    !state.lastPaymentAt &&
    daysBetween(state.trialEndDate, now) >= 0
  )
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

  if (state.renewalMode === "charge_required") {
    // A suspension is an explicit admin/dunning state; only a payment or
    // resume leaves it, never the passage of time (except expiry).
    const due = billingDueDate(state)
    if (daysBetween(due, now) < 0) {
      const next: SubscriptionStatus = state.status === "suspended" ? "suspended" : "active"
      return { ...base, status: next, changed: state.status !== next }
    }
    if (state.cancelAtPeriodEnd) {
      return { ...base, status: "cancelled", changed: state.status !== "cancelled" }
    }
    const phase = dunningPhase(due, now, state.config)
    let mapped: SubscriptionStatus = phase === "current" ? "active" : (phase as SubscriptionStatus)
    if (state.status === "suspended" && mapped !== "expired") mapped = "suspended"
    return { ...base, status: mapped, changed: state.status !== mapped }
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
