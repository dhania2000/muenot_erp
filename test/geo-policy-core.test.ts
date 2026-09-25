import { describe, expect, it } from "vitest"
import {
  type GeoPolicy,
  evaluateGeoPolicy,
  normalizeCountry,
  normalizeCountryList,
} from "@/lib/geo-policy-core"

function policy(overrides: Partial<GeoPolicy> = {}): GeoPolicy {
  return {
    enabled: overrides.enabled ?? true,
    mode: overrides.mode ?? "allow",
    countries: overrides.countries ?? ["US", "GB"],
    unknownAction: overrides.unknownAction ?? "block",
  }
}

describe("normalizeCountry", () => {
  it("upper-cases valid alpha-2 codes", () => {
    expect(normalizeCountry("us")).toBe("US")
    expect(normalizeCountry(" gb ")).toBe("GB")
  })
  it("rejects unresolved / invalid values as unknown", () => {
    expect(normalizeCountry("XX")).toBeNull()
    expect(normalizeCountry("T1")).toBeNull()
    expect(normalizeCountry("USA")).toBeNull()
    expect(normalizeCountry("")).toBeNull()
    expect(normalizeCountry(null)).toBeNull()
    expect(normalizeCountry(42)).toBeNull()
  })
})

describe("normalizeCountryList", () => {
  it("parses arrays and comma/space strings, de-dupes, drops invalid, sorts", () => {
    expect(normalizeCountryList(["us", "GB", "us", "zz9"])).toEqual(["GB", "US"])
    expect(normalizeCountryList("us, gb  de")).toEqual(["DE", "GB", "US"])
    expect(normalizeCountryList(undefined)).toEqual([])
  })
})

describe("evaluateGeoPolicy", () => {
  it("is inert when disabled", () => {
    const d = evaluateGeoPolicy(policy({ enabled: false }), "RU")
    expect(d.denied).toBe(false)
    expect(d.reason).toBe("policy_disabled")
  })

  it("is inert when no countries configured (cannot lock everyone out)", () => {
    const d = evaluateGeoPolicy(policy({ countries: [] }), "RU")
    expect(d.denied).toBe(false)
    expect(d.reason).toBe("no_countries_configured")
  })

  describe("allow-list mode", () => {
    it("permits a listed country", () => {
      const d = evaluateGeoPolicy(policy({ mode: "allow" }), "US")
      expect(d.denied).toBe(false)
      expect(d.reason).toBe("country_allowed")
    })
    it("denies a country not on the allow-list", () => {
      const d = evaluateGeoPolicy(policy({ mode: "allow" }), "RU")
      expect(d.denied).toBe(true)
      expect(d.reason).toBe("country_not_in_allowlist")
    })
  })

  describe("block-list mode", () => {
    it("denies a listed country", () => {
      const d = evaluateGeoPolicy(policy({ mode: "block", countries: ["RU", "KP"] }), "RU")
      expect(d.denied).toBe(true)
      expect(d.reason).toBe("country_blocked")
    })
    it("permits a country not on the block-list", () => {
      const d = evaluateGeoPolicy(policy({ mode: "block", countries: ["RU", "KP"] }), "US")
      expect(d.denied).toBe(false)
      expect(d.reason).toBe("country_allowed")
    })
  })

  describe("unknown location (VPN / proxy / unresolved IP)", () => {
    it("fails closed by default (unknownAction=block)", () => {
      const d = evaluateGeoPolicy(policy({ unknownAction: "block" }), null)
      expect(d.denied).toBe(true)
      expect(d.unknownLocation).toBe(true)
      expect(d.reason).toBe("location_unknown_blocked")
    })
    it("treats an XX/T1 edge code as unknown and fails closed", () => {
      const d = evaluateGeoPolicy(policy({ unknownAction: "block" }), "XX")
      expect(d.denied).toBe(true)
      expect(d.unknownLocation).toBe(true)
    })
    it("can be configured to permit unknown locations", () => {
      const d = evaluateGeoPolicy(policy({ unknownAction: "allow" }), null)
      expect(d.denied).toBe(false)
      expect(d.unknownLocation).toBe(true)
      expect(d.reason).toBe("location_unknown_allowed")
    })
  })
})
