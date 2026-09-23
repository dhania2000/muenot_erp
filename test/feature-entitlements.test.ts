import { describe, expect, it } from "vitest"
import { normalizeEntitlements, presetForCode } from "@/lib/platform/entitlements"
import {
  FEATURE_CATALOG,
  FEATURE_STATES,
  getFeatureDef,
  resolveFeature,
  resolveFeatureByKey,
  resolveAllFeatures,
} from "@/lib/platform/feature-entitlements"

/**
 * Phase 4. Bypass-resistance of the feature entitlement layer.
 *
 * These are pure resolver tests, but every case is framed as an attempted
 * BYPASS: a client that ignores hidden UI and asks for a feature/quantity it is
 * not entitled to. The resolver is what the server guard consults, so if the
 * resolver fails closed here, the API fails closed too. UI hiding is never the
 * thing under test.
 */

const enterprise = presetForCode("enterprise")
const starter = presetForCode("starter")

describe("catalog integrity", () => {
  it("every feature maps to a known kind and, when capacity-bound, a quota", () => {
    for (const f of FEATURE_CATALOG) {
      expect(["boolean", "limited", "metered"]).toContain(f.kind)
      if (f.kind === "limited" || f.kind === "metered") expect(f.quota).toBeTruthy()
      if (f.kind === "boolean") expect(f.quota).toBeUndefined()
    }
  })

  it("feature keys are unique", () => {
    const keys = FEATURE_CATALOG.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("resolves to one of the four canonical states", () => {
    for (const r of resolveAllFeatures(enterprise)) expect(FEATURE_STATES).toContain(r.state)
  })
})

describe("module gate is the hard line (bypass: call a feature outside the plan)", () => {
  it("disables a feature whose module the plan omits, regardless of kind", () => {
    // A plan with NO modules — a client posting to any feature endpoint must be refused.
    const ent = normalizeEntitlements({ modules: [], employees: 999, ai_credits_per_month: 999 })
    for (const def of FEATURE_CATALOG) {
      const r = resolveFeature(ent, def, 0, 1)
      expect(r.state).toBe("disabled")
      expect(r.available).toBe(false)
    }
  })

  it("enabling the module unlocks its boolean features", () => {
    const ent = normalizeEntitlements({ modules: ["crm"] })
    const r = resolveFeatureByKey(ent, "crm.pipeline")
    expect(r.state).toBe("enabled")
    expect(r.available).toBe(true)
  })
})

describe("boolean gating (bypass: flag / report-tier not on plan)", () => {
  it("a flag-gated feature stays disabled until the flag is granted", () => {
    const withModule = normalizeEntitlements({ modules: ["crm"] })
    expect(resolveFeatureByKey(withModule, "crm.bulk_import").state).toBe("disabled")

    const withFlag = normalizeEntitlements({ modules: ["crm"], feature_flags: "bulk_import" })
    expect(resolveFeatureByKey(withFlag, "crm.bulk_import").state).toBe("enabled")
  })

  it("advanced reports require the advanced tier even when the module is on", () => {
    const standard = normalizeEntitlements({ modules: ["reports"], reports: "standard" })
    expect(resolveFeatureByKey(standard, "reports.advanced").state).toBe("disabled")
    expect(resolveFeatureByKey(standard, "reports.standard").state).toBe("enabled")

    const advanced = normalizeEntitlements({ modules: ["reports"], reports: "advanced" })
    expect(resolveFeatureByKey(advanced, "reports.advanced").state).toBe("enabled")
  })
})

describe("limited features (bypass: request beyond the cap)", () => {
  const ent = normalizeEntitlements({ modules: ["automation"], automations: 3 })

  it("is LIMITED and admits units only while within the cap", () => {
    const room = resolveFeatureByKey(ent, "automation.workflows", 2, 1)
    expect(room.state).toBe("limited")
    expect(room.available).toBe(true)
    expect(room.remaining).toBe(1)
  })

  it("refuses the unit that would exceed the cap (server says no, UI aside)", () => {
    const over = resolveFeatureByKey(ent, "automation.workflows", 3, 1)
    expect(over.state).toBe("limited")
    expect(over.available).toBe(false)
    expect(over.reason).toMatch(/limit reached/i)
  })

  it("collapses to ENABLED when the quota is unlimited", () => {
    const unlimited = normalizeEntitlements({ modules: ["automation"], automations: null })
    const r = resolveFeatureByKey(unlimited, "automation.workflows", 9999, 9999)
    expect(r.state).toBe("enabled")
    expect(r.available).toBe(true)
  })

  it("a zero allowance disables the feature outright", () => {
    const zero = normalizeEntitlements({ modules: ["automation"], automations: 0 })
    const r = resolveFeatureByKey(zero, "automation.workflows", 0, 1)
    expect(r.state).toBe("disabled")
    expect(r.available).toBe(false)
  })
})

describe("metered features (bypass: exceed the included allowance)", () => {
  const ent = normalizeEntitlements({ modules: ["ai"], ai_credits_per_month: 100 })

  it("is METERED and remains usable while under the allowance", () => {
    const r = resolveFeatureByKey(ent, "ai.assistant", 50, 10)
    expect(r.state).toBe("metered")
    expect(r.available).toBe(true)
    expect(r.overage).toBe(false)
  })

  it("stays usable past the allowance but flags billable overage (never blocks)", () => {
    const r = resolveFeatureByKey(ent, "ai.assistant", 100, 10)
    expect(r.state).toBe("metered")
    expect(r.available).toBe(true)
    expect(r.overage).toBe(true)
    expect(r.reason).toMatch(/overage/i)
  })

  it("a zero metered allowance disables the feature", () => {
    const zero = normalizeEntitlements({ modules: ["ai"], ai_credits_per_month: 0 })
    expect(resolveFeatureByKey(zero, "ai.assistant", 0, 1).state).toBe("disabled")
  })
})

describe("unknown feature keys fail closed (bypass: invent a feature key)", () => {
  it("resolves an unknown key to disabled/unavailable", () => {
    const r = resolveFeatureByKey(enterprise, "totally.made_up")
    expect(r.state).toBe("disabled")
    expect(r.available).toBe(false)
  })

  it("getFeatureDef returns undefined for an unknown key", () => {
    expect(getFeatureDef("nope.nope")).toBeUndefined()
  })
})

describe("preset coherence", () => {
  it("enterprise enables/meters every non-flag feature (flags stay opt-in)", () => {
    // Enterprise grants every module and unlimited quotas, but feature FLAGS are
    // deliberately opt-in — a flag-gated feature stays disabled until switched on.
    for (const r of resolveAllFeatures(enterprise)) {
      const def = getFeatureDef(r.key)!
      if (def.flag) expect(r.state).toBe("disabled")
      else expect(r.state).not.toBe("disabled")
    }
  })

  it("enterprise + granted flags leaves nothing disabled", () => {
    const ent = normalizeEntitlements({ ...enterprise, feature_flags: ["bulk_import", "gst_filing"] })
    for (const r of resolveAllFeatures(ent)) expect(r.state).not.toBe("disabled")
  })

  it("starter disables modules it does not include (e.g. AI assistant)", () => {
    // starter grants crm, hr, finance, inventory, reports — not ai/automation.
    expect(resolveFeatureByKey(starter, "ai.assistant").state).toBe("disabled")
    expect(resolveFeatureByKey(starter, "automation.workflows").state).toBe("disabled")
    // but its included modules resolve as usable.
    expect(resolveFeatureByKey(starter, "finance.core").state).toBe("enabled")
  })
})
