import { describe, expect, it } from "vitest"
import { DEFAULT_LIFECYCLE, normalizeLifecycleConfig } from "@/lib/billing/subscription-lifecycle"
import {
  dueReminder,
  nextRetry,
  plannedRetryCount,
  retryOffsets,
  type ReminderInput,
} from "@/lib/billing/renewal-schedule"

/**
 * Phase 4. Pure, DB-free validation of the renewal schedule: which
 * reminder fires when, and how failed-payment retries are spaced and escalated
 * across the past-due + grace window. Uses fixed clocks so time-based scenarios
 * are deterministic.
 */

const cfg = normalizeLifecycleConfig(DEFAULT_LIFECYCLE)

function base(overrides: Partial<ReminderInput> = {}): ReminderInput {
  return {
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-02-01",
    config: cfg,
    ...overrides,
  }
}

describe("renewal reminders — pre-renewal ladder", () => {
  it("sends nothing when the renewal is far away", () => {
    // 60 days out — beyond the 30-day threshold.
    expect(dueReminder(base(), "2025-12-03")).toBeNull()
  })

  it("fires the 30-day reminder once inside the 30-day window", () => {
    const r = dueReminder(base(), "2026-01-05") // 27 days out
    expect(r?.kind).toBe("upcoming_30d")
  })

  it("fires the 7-day reminder inside the 7-day window", () => {
    const r = dueReminder(base(), "2026-01-27") // 5 days out
    expect(r?.kind).toBe("upcoming_7d")
  })

  it("fires the 1-day reminder the day before renewal", () => {
    const r = dueReminder(base(), "2026-01-31") // 1 day out
    expect(r?.kind).toBe("upcoming_1d")
  })

  it("does not re-send a reminder that was already sent", () => {
    const r = dueReminder(base(), "2026-01-05", ["upcoming_30d"])
    expect(r).toBeNull()
  })

  it("only sends the most urgent unsent reminder when discovered late", () => {
    // 5 days out, nothing sent yet: should send 7-day (most urgent reached),
    // NOT the 30-day one, so a late-discovered sub is not spammed.
    const r = dueReminder(base(), "2026-01-27", [])
    expect(r?.kind).toBe("upcoming_7d")
  })

  it("advances to the next reminder after the previous one was sent", () => {
    // 5 days out, 30-day already sent -> 7-day fires next.
    const r = dueReminder(base(), "2026-01-27", ["upcoming_30d"])
    expect(r?.kind).toBe("upcoming_7d")
  })

  it("suppresses reminders when set to cancel at period end", () => {
    expect(dueReminder(base({ cancelAtPeriodEnd: true }), "2026-01-31")).toBeNull()
  })

  it("suppresses reminders for terminal subscriptions", () => {
    expect(dueReminder(base({ status: "cancelled" }), "2026-01-31")).toBeNull()
    expect(dueReminder(base({ status: "expired" }), "2026-01-31")).toBeNull()
  })
})

describe("renewal reminders — dunning ladder", () => {
  it("sends the past-due notice right after the period lapses", () => {
    const r = dueReminder(base({ status: "past_due" }), "2026-02-03")
    expect(r?.kind).toBe("past_due_notice")
  })

  it("sends the grace notice once inside the grace window", () => {
    // past_due window is DEFAULT_LIFECYCLE.pastDueDays; step beyond it.
    const now = "2026-02-01"
    const daysIn = cfg.pastDueDays + 1
    const clock = new Date(Date.UTC(2026, 1, 1 + daysIn)).toISOString().slice(0, 10)
    const r = dueReminder(base({ status: "grace", currentPeriodEnd: now }), clock)
    expect(r?.kind).toBe("grace_notice")
  })

  it("does not repeat a dunning notice already sent", () => {
    const r = dueReminder(base({ status: "past_due" }), "2026-02-03", ["past_due_notice"])
    expect(r).toBeNull()
  })
})

describe("failed-payment retry schedule", () => {
  it("plans multiple attempts within the past-due + grace window", () => {
    expect(plannedRetryCount(cfg)).toBeGreaterThan(1)
    expect(retryOffsets(cfg).every((d) => d <= cfg.pastDueDays + cfg.graceDays)).toBe(true)
  })

  it("always keeps at least the immediate attempt for tiny windows", () => {
    const tiny = normalizeLifecycleConfig({ pastDueDays: 0, graceDays: 0, suspendDays: 0 })
    expect(retryOffsets(tiny)).toEqual([0])
  })

  it("marks the first attempt due immediately after lapse", () => {
    const d = nextRetry("2026-02-01", "2026-02-01", cfg, 0)
    expect(d.attemptNo).toBe(1)
    expect(d.due).toBe(true)
    expect(d.exhausted).toBe(false)
  })

  it("does not fire the next attempt before its scheduled date", () => {
    // One attempt made; the second is scheduled a few days out.
    const d = nextRetry("2026-02-01", "2026-02-02", cfg, 1)
    expect(d.attemptNo).toBe(2)
    expect(d.due).toBe(false)
  })

  it("fires the next attempt once its scheduled date arrives", () => {
    const offsets = retryOffsets(cfg)
    const secondOffset = offsets[1]
    const clock = new Date(Date.UTC(2026, 1, 1 + secondOffset)).toISOString().slice(0, 10)
    const d = nextRetry("2026-02-01", clock, cfg, 1)
    expect(d.attemptNo).toBe(2)
    expect(d.due).toBe(true)
  })

  it("reports exhaustion once every planned attempt has been made", () => {
    const total = plannedRetryCount(cfg)
    const d = nextRetry("2026-02-01", "2026-03-01", cfg, total)
    expect(d.exhausted).toBe(true)
    expect(d.due).toBe(false)
  })
})
