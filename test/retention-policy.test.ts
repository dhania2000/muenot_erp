import { describe, expect, it } from "vitest"
import {
  DEFAULT_RETENTION_RULE,
  MAX_RETENTION_AMOUNT,
  MIN_RETENTION_AMOUNT,
  addDuration,
  computeExpiry,
  describeRetentionRule,
  isExpired,
  isRetentionMode,
  isRetentionUnit,
  normalizeAmount,
  normalizeRetentionRule,
  resolveRule,
  shouldPurge,
  type RetentionRule,
} from "@/lib/storage/retention-policy"

/**
 * Phase 4. Pure, DB-free validation of the configurable retention
 * model: rule normalization, calendar-accurate expiry arithmetic, the
 * default → module → override → legal-hold resolution precedence, and the
 * single guarantee that legal-hold files are NEVER purged. Fixed clocks keep
 * every time-based assertion deterministic.
 */

// ---------------------------------------------------------------------------
// Guards & normalization
// ---------------------------------------------------------------------------

describe("guards", () => {
  it("recognizes valid modes and units", () => {
    expect(isRetentionMode("permanent")).toBe(true)
    expect(isRetentionMode("duration")).toBe(true)
    expect(isRetentionMode("forever")).toBe(false)
    expect(isRetentionUnit("days")).toBe(true)
    expect(isRetentionUnit("months")).toBe(true)
    expect(isRetentionUnit("years")).toBe(true)
    expect(isRetentionUnit("weeks")).toBe(false)
  })
})

describe("normalizeAmount", () => {
  it("clamps into the allowed whole-number range", () => {
    expect(normalizeAmount(0)).toBe(MIN_RETENTION_AMOUNT)
    expect(normalizeAmount(-5)).toBe(MIN_RETENTION_AMOUNT)
    expect(normalizeAmount(10_000)).toBe(MAX_RETENTION_AMOUNT)
    expect(normalizeAmount(3.9)).toBe(3)
    expect(normalizeAmount("7" as unknown)).toBe(7)
    expect(normalizeAmount("abc" as unknown)).toBe(MIN_RETENTION_AMOUNT)
  })
})

describe("normalizeRetentionRule", () => {
  it("falls back to the default mode/unit for garbage input", () => {
    // Garbage has no amount, so it clamps to the minimum (1) rather than the
    // default's 7 — but mode and unit fall back to the default rule.
    for (const bad of [null, {}, "nope" as unknown]) {
      const r = normalizeRetentionRule(bad)
      expect(r.mode).toBe(DEFAULT_RETENTION_RULE.mode)
      expect(r.unit).toBe(DEFAULT_RETENTION_RULE.unit)
      expect(r.amount).toBe(MIN_RETENTION_AMOUNT)
    }
  })

  it("preserves a valid duration rule and clamps its amount", () => {
    expect(normalizeRetentionRule({ mode: "duration", amount: 30, unit: "days" })).toEqual({
      mode: "duration",
      amount: 30,
      unit: "days",
    })
    expect(normalizeRetentionRule({ mode: "duration", amount: 0, unit: "months" })).toEqual({
      mode: "duration",
      amount: MIN_RETENTION_AMOUNT,
      unit: "months",
    })
  })

  it("keeps a nominal amount/unit on a permanent rule for UI round-tripping", () => {
    const r = normalizeRetentionRule({ mode: "permanent", amount: 5, unit: "years" })
    expect(r.mode).toBe("permanent")
    expect(r.amount).toBe(5)
    expect(r.unit).toBe("years")
  })
})

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

describe("addDuration — calendar accurate", () => {
  it("adds days", () => {
    const r = addDuration(new Date("2026-01-01T00:00:00Z"), 10, "days")
    expect(r.toISOString()).toBe("2026-01-11T00:00:00.000Z")
  })

  it("adds months landing on the same day", () => {
    const r = addDuration(new Date("2026-01-15T00:00:00Z"), 1, "months")
    expect(r.toISOString()).toBe("2026-02-15T00:00:00.000Z")
  })

  it("adds years respecting leap-year Feb 29", () => {
    // 2024-02-29 + 1 year → JS normalizes to 2025-03-01
    const r = addDuration(new Date("2024-02-29T00:00:00Z"), 1, "years")
    expect(r.toISOString()).toBe("2025-03-01T00:00:00.000Z")
  })

  it("never mutates the input date", () => {
    const from = new Date("2026-01-01T00:00:00Z")
    addDuration(from, 5, "years")
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })
})

describe("computeExpiry", () => {
  it("returns null for a permanent rule", () => {
    expect(computeExpiry({ mode: "permanent", amount: 1, unit: "years" })).toBeNull()
  })

  it("computes a concrete expiry for a duration rule", () => {
    const from = new Date("2026-01-01T00:00:00Z")
    expect(computeExpiry({ mode: "duration", amount: 7, unit: "years" }, from)?.toISOString()).toBe(
      "2033-01-01T00:00:00.000Z",
    )
  })
})

// ---------------------------------------------------------------------------
// Expiry / purge decisions
// ---------------------------------------------------------------------------

describe("isExpired", () => {
  const now = new Date("2026-06-01T00:00:00Z")
  it("treats null/undefined (permanent) as not expired", () => {
    expect(isExpired(null, now)).toBe(false)
    expect(isExpired(undefined, now)).toBe(false)
  })
  it("is inclusive at the boundary", () => {
    expect(isExpired("2026-06-01T00:00:00Z", now)).toBe(true)
  })
  it("distinguishes past vs future", () => {
    expect(isExpired("2026-05-31T23:59:59Z", now)).toBe(true)
    expect(isExpired("2026-06-01T00:00:01Z", now)).toBe(false)
  })
  it("ignores invalid dates", () => {
    expect(isExpired("not-a-date", now)).toBe(false)
  })
})

describe("shouldPurge — legal hold is absolute", () => {
  const now = new Date("2026-06-01T00:00:00Z")

  it("never purges a file on legal hold, even if long expired", () => {
    expect(shouldPurge({ legalHold: true, expiresAt: "2000-01-01T00:00:00Z" }, now)).toBe(false)
  })

  it("never purges a permanent file", () => {
    expect(shouldPurge({ legalHold: false, expiresAt: null }, now)).toBe(false)
  })

  it("purges an expired file with no hold", () => {
    expect(shouldPurge({ legalHold: false, expiresAt: "2026-05-01T00:00:00Z" }, now)).toBe(true)
  })

  it("keeps a not-yet-expired file", () => {
    expect(shouldPurge({ legalHold: false, expiresAt: "2027-01-01T00:00:00Z" }, now)).toBe(false)
  })

  it("legal hold overrides expiry regardless of order of checks", () => {
    // Even a file that is both expired AND permanent-less stays when held.
    expect(shouldPurge({ legalHold: true, expiresAt: "2026-05-31T00:00:00Z" }, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Resolution precedence
// ---------------------------------------------------------------------------

describe("resolveRule — module overrides default", () => {
  const def: RetentionRule = { mode: "duration", amount: 7, unit: "years" }

  it("uses the default when there is no module rule", () => {
    expect(resolveRule(def, null)).toEqual(def)
    expect(resolveRule(def, undefined)).toEqual(def)
  })

  it("uses the module rule when present", () => {
    const mod: RetentionRule = { mode: "duration", amount: 30, unit: "days" }
    expect(resolveRule(def, mod)).toEqual(mod)
  })

  it("a permanent module rule overrides a finite default", () => {
    expect(resolveRule(def, { mode: "permanent", amount: 1, unit: "years" }).mode).toBe("permanent")
  })
})

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------

describe("describeRetentionRule", () => {
  it("describes permanent", () => {
    expect(describeRetentionRule({ mode: "permanent", amount: 1, unit: "years" })).toMatch(/permanent/i)
  })
  it("singularizes a 1-unit duration", () => {
    expect(describeRetentionRule({ mode: "duration", amount: 1, unit: "years" })).toBe("1 year")
    expect(describeRetentionRule({ mode: "duration", amount: 1, unit: "months" })).toBe("1 month")
  })
  it("pluralizes multi-unit durations", () => {
    expect(describeRetentionRule({ mode: "duration", amount: 7, unit: "years" })).toBe("7 years")
    expect(describeRetentionRule({ mode: "duration", amount: 90, unit: "days" })).toBe("90 days")
  })
})
