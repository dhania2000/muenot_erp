import { describe, expect, it } from "vitest"
import {
  DEFAULT_SLA_POLICIES,
  type SlaSubject,
  computeDueDates,
  evaluateSla,
  normalizeIdempotencyKey,
  toPriority,
  toSupportLevel,
  toTicketStatus,
  validateSlaTarget,
  validateTicketInput,
} from "@/lib/support-sla/model"

/**
 * Spec28 (#127) — Pure tests for plan-based SLA: deadline computation, the
 * response/resolution clock states (including breach), and request validation.
 */

describe("plan tiers", () => {
  it("give faster promises to higher tiers", () => {
    expect(DEFAULT_SLA_POLICIES.dedicated.urgent.responseMinutes).toBeLessThan(
      DEFAULT_SLA_POLICIES.community.urgent.responseMinutes,
    )
    expect(DEFAULT_SLA_POLICIES.priority.high.resolutionMinutes).toBeLessThan(
      DEFAULT_SLA_POLICIES.email.high.resolutionMinutes,
    )
  })
})

describe("computeDueDates", () => {
  it("adds the targets (in minutes) to the created timestamp", () => {
    const created = new Date("2026-06-01T00:00:00.000Z")
    const { responseDueAt, resolutionDueAt } = computeDueDates(created, { responseMinutes: 60, resolutionMinutes: 480 })
    expect(responseDueAt.toISOString()).toBe("2026-06-01T01:00:00.000Z")
    expect(resolutionDueAt.toISOString()).toBe("2026-06-01T08:00:00.000Z")
  })
})

describe("evaluateSla (clock states incl. breach)", () => {
  const subject = (over: Partial<SlaSubject> = {}): SlaSubject => ({
    createdAt: "2026-06-01T00:00:00.000Z",
    responseDueAt: "2026-06-01T01:00:00.000Z",
    resolutionDueAt: "2026-06-01T10:00:00.000Z",
    firstResponseAt: null,
    resolvedAt: null,
    ...over,
  })

  it("is on_track early in the window", () => {
    const e = evaluateSla(subject(), new Date("2026-06-01T00:05:00.000Z"))
    expect(e.response).toBe("on_track")
    expect(e.responseRemainingMinutes).toBe(55)
  })

  it("is at_risk within the final fifth of the window", () => {
    // 60-min response window; at 00:55 only 5 min (8.3%) remain.
    expect(evaluateSla(subject(), new Date("2026-06-01T00:55:00.000Z")).response).toBe("at_risk")
  })

  it("breaches a running clock past its deadline", () => {
    const e = evaluateSla(subject(), new Date("2026-06-01T02:00:00.000Z"))
    expect(e.response).toBe("breached")
    expect(e.responseRemainingMinutes).toBeLessThan(0)
  })

  it("is met when the work landed before the deadline", () => {
    const e = evaluateSla(
      subject({ firstResponseAt: "2026-06-01T00:30:00.000Z" }),
      new Date("2026-06-01T02:00:00.000Z"),
    )
    expect(e.response).toBe("met")
  })

  it("breaches when the work landed after the deadline", () => {
    const e = evaluateSla(
      subject({ firstResponseAt: "2026-06-01T01:30:00.000Z" }),
      new Date("2026-06-01T02:00:00.000Z"),
    )
    expect(e.response).toBe("breached")
  })
})

describe("validateSlaTarget (failure)", () => {
  it("rejects out-of-range and inconsistent targets", () => {
    expect(validateSlaTarget({ responseMinutes: 1, resolutionMinutes: 100 })).toMatchObject({ ok: false })
    expect(validateSlaTarget({ responseMinutes: 100, resolutionMinutes: 50 })).toMatchObject({ ok: false })
    expect(validateSlaTarget({ responseMinutes: 30, resolutionMinutes: 240 })).toEqual({
      ok: true,
      value: { responseMinutes: 30, resolutionMinutes: 240 },
    })
  })
})

describe("validateTicketInput (failure & defaults)", () => {
  it("requires a subject and defaults priority to normal", () => {
    expect(validateTicketInput({ subject: "hi" })).toMatchObject({ ok: false })
    const ok = validateTicketInput({ subject: "Cannot log in", description: "since this morning" })
    expect(ok).toMatchObject({ ok: true })
    if (ok.ok) expect(ok.value.priority).toBe("normal")
    expect(validateTicketInput({ subject: "valid subject", priority: "nope" })).toMatchObject({ ok: false })
  })
})

describe("coercion & idempotency-key normalization", () => {
  it("coerces enum-ish inputs safely", () => {
    expect(toPriority("urgent")).toBe("urgent")
    expect(toPriority("boom")).toBeNull()
    expect(toSupportLevel("dedicated")).toBe("dedicated")
    expect(toSupportLevel("mystery")).toBe("community")
    expect(toTicketStatus("resolved")).toBe("resolved")
    expect(toTicketStatus("wat")).toBeNull()
  })

  it("accepts only header-safe bounded keys", () => {
    expect(normalizeIdempotencyKey("abc12345")).toBe("abc12345")
    expect(normalizeIdempotencyKey("short")).toBeNull()
    expect(normalizeIdempotencyKey("has spaces here")).toBeNull()
    expect(normalizeIdempotencyKey(null)).toBeNull()
  })
})
