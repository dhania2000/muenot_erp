import { describe, expect, it } from "vitest"
import {
  type CoreGrant,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  clampDurationMinutes,
  computeDueTransitions,
  isGrantCurrentlyActive,
  isGrantKind,
  isGrantableTenantRole,
  validateWindow,
} from "@/lib/temporary-access-core"

const NOW = new Date("2026-01-01T12:00:00Z").getTime()
const MIN = 60_000

function grant(overrides: Partial<CoreGrant> = {}): CoreGrant {
  return {
    id: overrides.id ?? 1,
    kind: overrides.kind ?? "temporary",
    status: overrides.status ?? "pending",
    startAt: overrides.startAt ?? NOW,
    expiresAt: overrides.expiresAt ?? NOW + 30 * MIN,
  }
}

describe("type guards", () => {
  it("recognises the two grant kinds", () => {
    expect(isGrantKind("temporary")).toBe(true)
    expect(isGrantKind("break_glass")).toBe(true)
    expect(isGrantKind("permanent")).toBe(false)
    expect(isGrantKind(42)).toBe(false)
  })

  it("only allows module_admin and tenant_admin to be granted", () => {
    expect(isGrantableTenantRole("module_admin")).toBe(true)
    expect(isGrantableTenantRole("tenant_admin")).toBe(true)
    // Ownership can never be conferred via a time-boxed elevation.
    expect(isGrantableTenantRole("owner")).toBe(false)
    expect(isGrantableTenantRole("employee")).toBe(false)
  })
})

describe("computeDueTransitions — scheduled activation", () => {
  it("activates a pending temporary grant once its start time has arrived", () => {
    const g = grant({ id: 7, status: "pending", startAt: NOW - MIN, expiresAt: NOW + 10 * MIN })
    const { toActivate, toExpire } = computeDueTransitions([g], NOW)
    expect(toActivate).toEqual([7])
    expect(toExpire).toEqual([])
  })

  it("does not activate a pending temporary grant before its start time", () => {
    const g = grant({ id: 8, status: "pending", startAt: NOW + 5 * MIN, expiresAt: NOW + 10 * MIN })
    const { toActivate, toExpire } = computeDueTransitions([g], NOW)
    expect(toActivate).toEqual([])
    expect(toExpire).toEqual([])
  })

  it("never auto-activates a pending break-glass grant (requires human approval)", () => {
    const g = grant({ id: 9, kind: "break_glass", status: "pending", startAt: NOW - MIN, expiresAt: NOW + 10 * MIN })
    const { toActivate } = computeDueTransitions([g], NOW)
    expect(toActivate).toEqual([])
  })
})

describe("computeDueTransitions — automatic revocation", () => {
  it("expires an active grant of either kind once past its expiry", () => {
    const temp = grant({ id: 1, kind: "temporary", status: "active", startAt: NOW - 30 * MIN, expiresAt: NOW - MIN })
    const bg = grant({ id: 2, kind: "break_glass", status: "active", startAt: NOW - 30 * MIN, expiresAt: NOW })
    const { toExpire } = computeDueTransitions([temp, bg], NOW)
    expect(toExpire.sort()).toEqual([1, 2])
  })

  it("leaves an active grant alone while still inside its window", () => {
    const g = grant({ id: 3, status: "active", startAt: NOW - MIN, expiresAt: NOW + MIN })
    const { toActivate, toExpire } = computeDueTransitions([g], NOW)
    expect(toActivate).toEqual([])
    expect(toExpire).toEqual([])
  })

  it("expires a pending grant that was never activated before its own expiry", () => {
    const g = grant({ id: 4, status: "pending", startAt: NOW - 10 * MIN, expiresAt: NOW - MIN })
    const { toActivate, toExpire } = computeDueTransitions([g], NOW)
    expect(toActivate).toEqual([])
    expect(toExpire).toEqual([4])
  })

  it("ignores grants that are already terminal", () => {
    const grants: CoreGrant[] = [
      grant({ id: 1, status: "expired", expiresAt: NOW - MIN }),
      grant({ id: 2, status: "revoked", expiresAt: NOW - MIN }),
      grant({ id: 3, status: "rejected", expiresAt: NOW - MIN }),
    ]
    const { toActivate, toExpire } = computeDueTransitions(grants, NOW)
    expect(toActivate).toEqual([])
    expect(toExpire).toEqual([])
  })

  it("handles a mixed batch in a single pass", () => {
    const grants: CoreGrant[] = [
      grant({ id: 10, kind: "temporary", status: "pending", startAt: NOW - MIN, expiresAt: NOW + 10 * MIN }), // activate
      grant({ id: 11, kind: "temporary", status: "active", startAt: NOW - 10 * MIN, expiresAt: NOW - MIN }), // expire
      grant({ id: 12, kind: "break_glass", status: "pending", startAt: NOW - MIN, expiresAt: NOW + 10 * MIN }), // neither
    ]
    const { toActivate, toExpire } = computeDueTransitions(grants, NOW)
    expect(toActivate).toEqual([10])
    expect(toExpire).toEqual([11])
  })
})

describe("isGrantCurrentlyActive", () => {
  it("is true only for an active grant inside its window", () => {
    expect(isGrantCurrentlyActive(grant({ status: "active", startAt: NOW - MIN, expiresAt: NOW + MIN }), NOW)).toBe(true)
    expect(isGrantCurrentlyActive(grant({ status: "pending", startAt: NOW - MIN, expiresAt: NOW + MIN }), NOW)).toBe(
      false,
    )
    expect(isGrantCurrentlyActive(grant({ status: "active", startAt: NOW + MIN, expiresAt: NOW + 2 * MIN }), NOW)).toBe(
      false,
    )
    expect(isGrantCurrentlyActive(grant({ status: "active", startAt: NOW - 2 * MIN, expiresAt: NOW }), NOW)).toBe(false)
  })
})

describe("validateWindow — duration policy", () => {
  it("accepts a window within the allowed bounds", () => {
    expect(validateWindow(NOW, NOW + 30 * MIN, NOW)).toEqual({ ok: true })
  })

  it("rejects non-finite times", () => {
    expect(validateWindow(Number.NaN, NOW + MIN, NOW).ok).toBe(false)
    expect(validateWindow(NOW, Number.POSITIVE_INFINITY, NOW).ok).toBe(false)
  })

  it("rejects an expiry that is not after the start", () => {
    expect(validateWindow(NOW, NOW, NOW).ok).toBe(false)
    expect(validateWindow(NOW + MIN, NOW, NOW).ok).toBe(false)
  })

  it("rejects an expiry in the past", () => {
    expect(validateWindow(NOW - 10 * MIN, NOW - MIN, NOW).ok).toBe(false)
  })

  it("enforces the minimum duration", () => {
    const res = validateWindow(NOW, NOW + (MIN_DURATION_MINUTES - 1) * MIN, NOW)
    expect(res.ok).toBe(false)
  })

  it("enforces the maximum duration", () => {
    const res = validateWindow(NOW, NOW + (MAX_DURATION_MINUTES + 1) * MIN, NOW)
    expect(res.ok).toBe(false)
  })
})

describe("clampDurationMinutes", () => {
  it("clamps below the minimum and above the maximum", () => {
    expect(clampDurationMinutes(1)).toBe(MIN_DURATION_MINUTES)
    expect(clampDurationMinutes(MAX_DURATION_MINUTES + 1000)).toBe(MAX_DURATION_MINUTES)
  })

  it("rounds fractional inputs and passes through valid values", () => {
    expect(clampDurationMinutes(30.4)).toBe(30)
    expect(clampDurationMinutes(45.6)).toBe(46)
  })

  it("falls back to the minimum for non-finite input", () => {
    expect(clampDurationMinutes(Number.NaN)).toBe(MIN_DURATION_MINUTES)
  })
})
