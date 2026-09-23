import { describe, expect, it } from "vitest"
import {
  ENTITLEMENT_PRESETS,
  EMPTY_ENTITLEMENTS,
  MODULE_KEYS,
  QUOTA_KEYS,
  checkQuota,
  formatQuota,
  hasFeatureFlag,
  hasModule,
  isUnlimited,
  meetsReportLevel,
  normalizeEntitlements,
  parseEntitlements,
  presetForCode,
  reportLevelRank,
  supportLevelRank,
} from "@/lib/platform/entitlements"

/**
 * Phase 4. Pure, DB-free validation of the entitlement model and the
 * enforcement primitives every gate is built on: quota normalization, the
 * unlimited sentinel, capacity checks, and module/flag/report gating.
 */

describe("quota normalization", () => {
  it("treats null / empty / 'unlimited' / negative as unlimited", () => {
    for (const raw of [null, undefined, "", "unlimited", "∞", -1, -100, Infinity]) {
      const ent = normalizeEntitlements({ users: raw })
      expect(ent.users).toBeNull()
    }
  })

  it("floors finite numeric quotas to non-negative integers", () => {
    expect(normalizeEntitlements({ employees: 12.9 }).employees).toBe(12)
    expect(normalizeEntitlements({ employees: "25" }).employees).toBe(25)
    expect(normalizeEntitlements({ employees: 0 }).employees).toBe(0)
  })

  it("rejects unknown modules and de-duplicates the rest", () => {
    const ent = normalizeEntitlements({ modules: ["crm", "crm", "not_a_module", "HR"] })
    expect(ent.modules).toEqual(["crm", "hr"])
  })

  it("accepts feature flags as a comma string or an array, lower-cased", () => {
    expect(normalizeEntitlements({ feature_flags: "Beta, Export ,beta" }).feature_flags).toEqual([
      "beta",
      "export",
    ])
    expect(normalizeEntitlements({ feature_flags: ["A", "b"] }).feature_flags).toEqual(["a", "b"])
  })

  it("falls back to the safe floor for enum tiers", () => {
    const ent = normalizeEntitlements({ reports: "wat", support_level: "nope" })
    expect(ent.reports).toBe("none")
    expect(ent.support_level).toBe("community")
  })

  it("never throws on garbage input and returns a complete shape", () => {
    // A non-object coerces to an empty source: absent quota fields normalize to
    // the unlimited sentinel (null), while list/enum fields fall to the floor.
    const ent = normalizeEntitlements("total garbage")
    for (const k of QUOTA_KEYS) expect(ent[k]).toBeNull()
    expect(ent.modules).toEqual([])
    expect(ent.feature_flags).toEqual([])
    expect(ent.reports).toBe("none")
    expect(ent.support_level).toBe("community")
  })
})

describe("parseEntitlements", () => {
  it("parses a JSON string round-trip", () => {
    const stored = JSON.stringify(ENTITLEMENT_PRESETS.growth)
    expect(parseEntitlements(stored)).toEqual(ENTITLEMENT_PRESETS.growth)
  })

  it("returns the empty floor for null or corrupt JSON", () => {
    expect(parseEntitlements(null)).toEqual(EMPTY_ENTITLEMENTS)
    expect(parseEntitlements("{not json")).toEqual(EMPTY_ENTITLEMENTS)
  })
})

describe("unlimited sentinel", () => {
  it("null means unlimited, finite does not", () => {
    expect(isUnlimited(null)).toBe(true)
    expect(isUnlimited(0)).toBe(false)
    expect(formatQuota(null)).toBe("Unlimited")
    expect(formatQuota(250)).toBe("250")
  })
})

describe("checkQuota", () => {
  const ent = normalizeEntitlements({ users: 10, integrations: null })

  it("allows while usage + requested stays within a finite cap", () => {
    const c = checkQuota(ent, "users", 9, 1)
    expect(c.allowed).toBe(true)
    expect(c.remaining).toBe(1)
    expect(c.unlimited).toBe(false)
  })

  it("denies when the request would exceed the cap", () => {
    const c = checkQuota(ent, "users", 10, 1)
    expect(c.allowed).toBe(false)
    expect(c.remaining).toBe(0)
  })

  it("always allows an unlimited dimension", () => {
    const c = checkQuota(ent, "integrations", 9_999, 9_999)
    expect(c.allowed).toBe(true)
    expect(c.unlimited).toBe(true)
    expect(c.remaining).toBeNull()
  })

  it("clamps negative / fractional usage and requested to safe integers", () => {
    const c = checkQuota(ent, "users", -5, 3.9)
    expect(c.usage).toBe(0)
    expect(c.allowed).toBe(true)
  })

  it("a zero cap blocks the first unit", () => {
    const zero = normalizeEntitlements({ users: 0 })
    expect(checkQuota(zero, "users", 0, 1).allowed).toBe(false)
  })
})

describe("capability gates", () => {
  const ent = normalizeEntitlements({
    modules: ["crm", "finance"],
    feature_flags: "beta_dashboard",
    reports: "standard",
  })

  it("hasModule reflects the granted set", () => {
    expect(hasModule(ent, "crm")).toBe(true)
    expect(hasModule(ent, "inventory")).toBe(false)
  })

  it("hasFeatureFlag is case-insensitive", () => {
    expect(hasFeatureFlag(ent, "BETA_DASHBOARD")).toBe(true)
    expect(hasFeatureFlag(ent, "missing")).toBe(false)
  })

  it("meetsReportLevel honors tier ordering", () => {
    expect(meetsReportLevel(ent, "none")).toBe(true)
    expect(meetsReportLevel(ent, "standard")).toBe(true)
    expect(meetsReportLevel(ent, "advanced")).toBe(false)
    expect(reportLevelRank("advanced")).toBeGreaterThan(reportLevelRank("standard"))
    expect(supportLevelRank("dedicated")).toBeGreaterThan(supportLevelRank("community"))
  })
})

describe("presets", () => {
  it("enterprise is unlimited on every quota and grants every module", () => {
    const ent = presetForCode("enterprise")
    for (const k of QUOTA_KEYS) expect(ent[k]).toBeNull()
    expect(ent.modules).toEqual([...MODULE_KEYS])
    expect(ent.support_level).toBe("dedicated")
  })

  it("tiers escalate: starter caps are below growth caps", () => {
    expect((presetForCode("starter").users ?? Infinity)).toBeLessThan(
      presetForCode("growth").users ?? Infinity,
    )
  })

  it("an unknown code falls back to the starter preset", () => {
    expect(presetForCode("does_not_exist")).toEqual(ENTITLEMENT_PRESETS.starter)
  })
})
