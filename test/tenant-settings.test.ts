import { describe, expect, it } from "vitest"
import {
  MASKED_SECRET,
  getTenantSettingDefinition,
  listTenantSettingDefinitions,
  validateTenantSetting,
} from "@/lib/tenant-settings"

describe("tenant settings registry and validation", () => {
  it("contains the complete company settings catalog without duplicate keys", () => {
    const definitions = listTenantSettingDefinitions()
    expect(definitions.length).toBeGreaterThan(150)
    expect(new Set(definitions.map((definition) => definition.key)).size).toBe(definitions.length)
  })

  it("validates known types and rejects unknown keys", () => {
    expect(validateTenantSetting("currency.decimals", "2")).toEqual({ ok: true, value: "2" })
    expect(validateTenantSetting("currency.decimals", "not-a-number").ok).toBe(false)
    expect(validateTenantSetting("currency.default_code", "INR").ok).toBe(true)
    expect(validateTenantSetting("currency.default_code", "BTC").ok).toBe(false)
    expect(validateTenantSetting("not.a.real.setting", "x").ok).toBe(false)
  })

  it("treats empty values as an explicit override reset", () => {
    expect(validateTenantSetting("company.name", "")).toEqual({ ok: true, value: "" })
  })

  it("keeps secret definitions discoverable without exposing a value", () => {
    const secret = getTenantSettingDefinition("payment.razorpay_secret")
    expect(secret?.secret).toBe(true)
    expect(MASKED_SECRET).not.toContain("secret")
  })
})
