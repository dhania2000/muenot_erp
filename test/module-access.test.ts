import { describe, expect, it } from "vitest"
import {
  TOGGLEABLE_MODULES,
  moduleSettingKey,
  isModuleEnabledInSettings,
} from "@/lib/module-access"

describe("tenant module configuration (SPEC 45)", () => {
  it("maps toggleable slugs (and their sub-paths) to their module setting key", () => {
    expect(moduleSettingKey("finance")).toBe("module.finance")
    expect(moduleSettingKey("Finance")).toBe("module.finance")
    // Only the first path segment decides the module.
    expect(moduleSettingKey("finance/sales-invoices")).toBe("module.finance")
    expect(moduleSettingKey("/hr/employees?tab=1")).toBe("module.hr")
  })

  it("returns null for non-toggleable modules (always available)", () => {
    expect(moduleSettingKey("tasks")).toBeNull()
    expect(moduleSettingKey("management")).toBeNull()
    expect(moduleSettingKey("storage")).toBeNull()
    expect(moduleSettingKey("")).toBeNull()
    // Non-toggleable slugs are always enabled regardless of settings.
    expect(isModuleEnabledInSettings({ "module.tasks": "false" }, "tasks")).toBe(true)
  })

  it("defaults to ENABLED when the tenant never set the toggle", () => {
    for (const m of TOGGLEABLE_MODULES) {
      expect(isModuleEnabledInSettings({}, m)).toBe(true)
    }
    // Empty string is treated as "unset" → default enabled.
    expect(isModuleEnabledInSettings({ "module.finance": "" }, "finance")).toBe(true)
  })

  it("honours an explicit disable across every accepted truthy/falsy form", () => {
    for (const on of ["Enabled", "true", "1", "yes", "on", "ON"]) {
      expect(isModuleEnabledInSettings({ "module.finance": on }, "finance")).toBe(true)
    }
    for (const off of ["Disabled", "false", "0", "no", "off", "nonsense"]) {
      expect(isModuleEnabledInSettings({ "module.finance": off }, "finance")).toBe(false)
    }
  })

  it("gates a sub-path exactly like its parent module", () => {
    const disabled = { "module.finance": "Disabled" }
    expect(isModuleEnabledInSettings(disabled, "finance")).toBe(false)
    expect(isModuleEnabledInSettings(disabled, "finance/sales-invoices")).toBe(false)
    expect(isModuleEnabledInSettings(disabled, "finance/purchase-bills?x=1")).toBe(false)
  })

  it("keeps two tenants' module configuration fully isolated", () => {
    // Tenant A disables finance but keeps HR; tenant B is the mirror image.
    const tenantA: Record<string, string> = { "module.finance": "Disabled", "module.hr": "Enabled" }
    const tenantB: Record<string, string> = { "module.finance": "Enabled", "module.hr": "Disabled" }

    expect(isModuleEnabledInSettings(tenantA, "finance")).toBe(false)
    expect(isModuleEnabledInSettings(tenantA, "hr")).toBe(true)

    expect(isModuleEnabledInSettings(tenantB, "finance")).toBe(true)
    expect(isModuleEnabledInSettings(tenantB, "hr")).toBe(false)

    // A tenant that disabled nothing sees everything — no shared/global state
    // leaks a disable from tenant A or B.
    for (const m of TOGGLEABLE_MODULES) {
      expect(isModuleEnabledInSettings({}, m)).toBe(true)
    }
  })
})
