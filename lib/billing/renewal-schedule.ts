/**
 * SPEC 24 — Renewal management scheduling core (pure, dependency-free).
 * ---------------------------------------------------------------------------
 * Phase 1 of renewal management: the deterministic rules that decide, for a
 * given subscription at a given moment, WHICH renewal reminder is due and WHEN
 * a failed-payment retry should be attempted. Kept as pure functions (no DB, no
 * request context) so the whole schedule can be unit-tested with fixed clocks
 * (see test/renewal-schedule.test.ts).
 *
 * The DB-backed orchestrator (lib/billing/renewal-engine.ts) composes these
 * with tenant-scoped persistence, email delivery and the subscription/billing
 * engines to run a full renewal cycle.
 *
 * It builds on the SPEC 16 lifecycle primitives (dunning ladder, date math) so
 * reminders and retries stay aligned with how the lifecycle itself transitions.
 */

import {
  addDays,
  daysBetween,
  dunningPhase,
  type LifecycleConfig,
  type SubscriptionStatus,
} from "@/lib/billing/subscription-lifecycle"

// ── Reminder kinds ────────────────────────────────────────────────────────────

/** Reminders sent BEFORE a renewal falls due, while still in good standing. */
export const PRE_RENEWAL_REMINDER_KINDS = ["upcoming_30d", "upcoming_7d", "upcoming_1d"] as const
/** Reminders sent AFTER a renewal lapses, walking the dunning ladder. */
export const DUNNING_REMINDER_KINDS = ["past_due_notice", "grace_notice", "final_notice"] as const

export const REMINDER_KINDS = [...PRE_RENEWAL_REMINDER_KINDS, ...DUNNING_REMINDER_KINDS] as const
export type ReminderKind = (typeof REMINDER_KINDS)[number]

export const REMINDER_LABELS: Record<ReminderKind, string> = {
  upcoming_30d: "Renewal in 30 days",
  upcoming_7d: "Renewal in 7 days",
  upcoming_1d: "Renews tomorrow",
  past_due_notice: "Payment past due",
  grace_notice: "Grace period — action required",
  final_notice: "Final notice before suspension",
}

/** Days-before-renewal thresholds, most-distant first. */
export const PRE_RENEWAL_OFFSETS: { kind: (typeof PRE_RENEWAL_REMINDER_KINDS)[number]; daysBefore: number }[] = [
  { kind: "upcoming_30d", daysBefore: 30 },
  { kind: "upcoming_7d", daysBefore: 7 },
  { kind: "upcoming_1d", daysBefore: 1 },
]

export function isReminderKind(v: unknown): v is ReminderKind {
  return typeof v === "string" && (REMINDER_KINDS as readonly string[]).includes(v)
}

// ── Due-reminder derivation ─────────────────────────────────────────────────

export type ReminderInput = {
  status: SubscriptionStatus
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string
  config: LifecycleConfig
}

export type DueReminder = {
  kind: ReminderKind
  /** The renewal (or lapse) date the reminder is about. */
  referenceDate: string
  reason: string
}

/**
 * Which single reminder — if any — should be sent at `now`, given the reminders
 * already sent for the current period. Returns at most one reminder so a
 * subscription discovered late (e.g. created 3 days before renewal) does not get
 * blasted with every earlier reminder at once: only the most urgent unsent
 * pre-renewal reminder, or the current dunning-phase reminder, fires.
 */
export function dueReminder(
  input: ReminderInput,
  now: string,
  alreadySent: Iterable<ReminderKind> = [],
): DueReminder | null {
  const sent = new Set(alreadySent)

  // No reminders for terminal records or subscriptions already set to cancel.
  if (input.status === "cancelled" || input.status === "expired") return null
  if (input.cancelAtPeriodEnd) return null

  const daysToEnd = daysBetween(now, input.currentPeriodEnd)

  // Pre-renewal window: still in good standing and the period has not ended.
  if (daysToEnd >= 0 && (input.status === "active" || input.status === "trial")) {
    // Every threshold that has been reached, most urgent last.
    const reached = PRE_RENEWAL_OFFSETS.filter((o) => daysToEnd <= o.daysBefore).sort(
      (a, b) => b.daysBefore - a.daysBefore,
    )
    // Fire the most urgent (smallest daysBefore) reached reminder not yet sent.
    const next = [...reached].reverse().find((o) => !sent.has(o.kind))
    if (!next) return null
    return {
      kind: next.kind,
      referenceDate: input.currentPeriodEnd,
      reason: daysToEnd === 0 ? "Renews today" : `Renews in ${daysToEnd} day(s)`,
    }
  }

  // Dunning window: the period ended without a successful renewal.
  const phase = dunningPhase(input.currentPeriodEnd, now, input.config)
  const kind: ReminderKind | null =
    phase === "past_due"
      ? "past_due_notice"
      : phase === "grace"
        ? "grace_notice"
        : phase === "suspended"
          ? "final_notice"
          : null
  if (!kind || sent.has(kind)) return null
  return {
    kind,
    referenceDate: input.currentPeriodEnd,
    reason: `Renewal payment overdue — ${phase.replace("_", " ")}`,
  }
}

// ── Failed-payment retry schedule ─────────────────────────────────────────────

/**
 * Day offsets (from the lapsed period-end date) at which to retry collecting a
 * failed renewal payment. Spread across the past-due + grace window so retries
 * stop before the subscription would be suspended. Clamped to the window and
 * always contains at least the immediate (day 0) attempt.
 */
export function retryOffsets(config: LifecycleConfig): number[] {
  const window = Math.max(1, config.pastDueDays + config.graceDays)
  const within = [0, 3, 7, 14].filter((d) => d <= window)
  return within.length ? within : [0]
}

/** Total retry attempts the schedule plans for the given config. */
export function plannedRetryCount(config: LifecycleConfig): number {
  return retryOffsets(config).length
}

export type RetryDecision = {
  /** True when the next attempt is due at or before `now`. */
  due: boolean
  /** 1-based number of the attempt this decision refers to. */
  attemptNo: number
  /** Calendar date the attempt is scheduled for. */
  scheduledFor: string
  /** True when every planned attempt has already been made — time to escalate. */
  exhausted: boolean
}

/**
 * Decide the next retry attempt for a lapsed renewal, given how many attempts
 * have already been recorded for this period. Deterministic and total.
 */
export function nextRetry(
  periodEnd: string,
  now: string,
  config: LifecycleConfig,
  attemptsMade: number,
): RetryDecision {
  const offsets = retryOffsets(config)
  const madeClamped = Math.max(0, Math.floor(attemptsMade))

  if (madeClamped >= offsets.length) {
    return {
      due: false,
      attemptNo: madeClamped,
      scheduledFor: addDays(periodEnd, offsets[offsets.length - 1]),
      exhausted: true,
    }
  }

  const scheduledFor = addDays(periodEnd, offsets[madeClamped])
  return {
    due: daysBetween(scheduledFor, now) >= 0,
    attemptNo: madeClamped + 1,
    scheduledFor,
    exhausted: false,
  }
}
