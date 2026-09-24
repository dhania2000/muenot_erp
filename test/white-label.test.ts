import { describe, expect, it } from "vitest"
import {
  computeWhiteLabel,
  planAllowsWhiteLabel,
  WHITE_LABEL_FLAG,
  VENDOR,
} from "@/lib/white-label"
import { ENTITLEMENT_PRESETS, presetForCode, normalizeEntitlements } from "@/lib/platform/entitlements"

describe("white-label gating decision (SPEC 156)", () => {
  it("removes vendor attribution ONLY when the plan grants it AND the tenant opts in", () => {
    const both = computeWhiteLabel({ planAllows: true, optedIn: true })
    expect(both.hideVendor).toBe(true)
    expect(both.poweredByText).toBe("")
  })

  it("shows vendor attribution for every other plan/opt-in combination (fail-safe)", () => {
    const cases = [
      { planAllows: false, optedIn: false },
      { planAllows: true, optedIn: false }, // paid but not opted in
      { planAllows: false, optedIn: true }, // opted in but not paid — must NOT strip
    ]
    for (const c of cases) {
      const wl = computeWhiteLabel(c)
      expect(wl.hideVendor).toBe(false)
      expect(wl.poweredByText).toBe(`Powered by ${VENDOR.name}`)
    }
  })

  it("coerces truthy-ish inputs to strict booleans and never leaks vendor internals", () => {
    // @ts-expect-error — exercising the Boolean() coercion guard with loose input.
    const wl = computeWhiteLabel({ planAllows: 1, optedIn: "yes" })
    expect(wl.planAllows).toBe(true)
    expect(wl.optedIn).toBe(true)
    expect(wl.hideVendor).toBe(true)
    expect(wl.vendor).toEqual({ name: VENDOR.name, url: VENDOR.url })
  })
})

describe("plan entitlement grant for white-label (SPEC 156)", () => {
  it("recognises the white-label flag only on plans that include it", () => {
    // The enterprise preset is the plan that ships the white_label flag.
    expect(planAllowsWhiteLabel(ENTITLEMENT_PRESETS.enterprise)).toBe(true)
    expect(planAllowsWhiteLabel(ENTITLEMENT_PRESETS.starter)).toBe(false)
    expect(planAllowsWhiteLabel(ENTITLEMENT_PRESETS.trial)).toBe(false)
    expect(planAllowsWhiteLabel(ENTITLEMENT_PRESETS.growth)).toBe(false)
  })

  it("uses the shared feature-flag vocabulary (no divergent flag string)", () => {
    expect(ENTITLEMENT_PRESETS.enterprise.feature_flags).toContain(WHITE_LABEL_FLAG)
  })

  it("resolves the grant through the same preset lookup the app uses", () => {
    expect(planAllowsWhiteLabel(presetForCode("enterprise"))).toBe(true)
    expect(planAllowsWhiteLabel(presetForCode("starter"))).toBe(false)
  })

  it("treats a corrupt or empty entitlement as NOT granting white-label", () => {
    expect(planAllowsWhiteLabel(normalizeEntitlements(null))).toBe(false)
    expect(planAllowsWhiteLabel(normalizeEntitlements({}))).toBe(false)
    expect(planAllowsWhiteLabel(normalizeEntitlements({ feature_flags: "not-an-array" }))).toBe(false)
  })
})

describe("white-label tenant isolation (SPEC 156)", () => {
  it("keeps two tenants' white-label decisions independent", () => {
    // Tenant A: paid + opted in → branding fully white-labelled.
    const tenantA = computeWhiteLabel({
      planAllows: planAllowsWhiteLabel(ENTITLEMENT_PRESETS.enterprise),
      optedIn: true,
    })
    // Tenant B: same opt-in, but a plan WITHOUT the grant → vendor stays.
    const tenantB = computeWhiteLabel({
      planAllows: planAllowsWhiteLabel(ENTITLEMENT_PRESETS.starter),
      optedIn: true,
    })

    expect(tenantA.hideVendor).toBe(true)
    expect(tenantA.poweredByText).toBe("")
    expect(tenantB.hideVendor).toBe(false)
    expect(tenantB.poweredByText).toBe(`Powered by ${VENDOR.name}`)
  })

  it("returns a fresh config object per call (no shared mutable state across tenants)", () => {
    const a = computeWhiteLabel({ planAllows: true, optedIn: true })
    const b = computeWhiteLabel({ planAllows: true, optedIn: true })
    expect(a).not.toBe(b)
    expect(a.vendor).not.toBe(b.vendor)
    // Mutating one tenant's projection must never leak into another's.
    a.vendor.name = "Hijacked"
    expect(b.vendor.name).toBe(VENDOR.name)
  })
})
