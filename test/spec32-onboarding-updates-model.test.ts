import { describe, expect, it } from "vitest"
import { applicableStepsFor, computeChecklist, countEnabledModules, normalizeOverride } from "@/lib/onboarding/model"
import { isUpdateVisibleTo, normalizeIdempotencyKey, validateUpdateInput } from "@/lib/product-updates/model"

describe("onboarding checklist progress recalculation", () => {
  const none = { company: false, users: false, email: false, storage: false, modules: false }

  it("starts at 0% with the first step next", () => {
    const c = computeChecklist({ signals: none, overrides: {} })
    expect(c).toMatchObject({ total: 5, completed: 0, percent: 0, complete: false, nextStep: "company" })
  })

  it("recalculates when signals flip and resumes at the next todo step", () => {
    const c = computeChecklist({ signals: { ...none, company: true, users: true }, overrides: {} })
    expect(c.completed).toBe(2)
    expect(c.percent).toBe(40)
    expect(c.nextStep).toBe("email")
  })

  it("counts skipped and manually done steps as complete; skip beats auto", () => {
    const c = computeChecklist({ signals: { ...none, storage: true }, overrides: { email: "done", storage: "skipped" } })
    expect(c.steps.find((s) => s.key === "storage")?.state).toBe("skipped")
    expect(c.completed).toBe(2)
  })

  it("drops the modules step from the denominator when all modules are hidden", () => {
    const applicable = applicableStepsFor({ enabledModules: 0 })
    expect(applicable).not.toContain("modules")
    const c = computeChecklist({ signals: { ...none, company: true, users: true, email: true, storage: true }, overrides: {}, applicable })
    expect(c).toMatchObject({ total: 4, percent: 100, complete: true })
  })

  it("rejects unknown override states", () => {
    expect(() => normalizeOverride("finished")).toThrow()
  })
})

describe("tenant module visibility", () => {
  const slugs = ["crm", "hr", "inventory"]

  it("treats modules without a toggle as visible", () => {
    expect(countEnabledModules(slugs, {})).toBe(3)
  })

  it("lets a tenant override hide a globally enabled module", () => {
    const merged = { ...{ "module.crm": "1" }, ...{ "module.crm": "0", "module.hr": "off" } }
    expect(countEnabledModules(slugs, merged)).toBe(1)
  })
})

describe("release note audience and validation", () => {
  const base = { status: "published", audienceConfig: {} }

  it("never shows drafts or archived notes", () => {
    expect(isUpdateVisibleTo({ ...base, status: "draft", audienceType: "all" }, { tenantId: 1, role: "admin" })).toBe(false)
    expect(isUpdateVisibleTo({ ...base, status: "archived", audienceType: "all" }, { tenantId: 1, role: "admin" })).toBe(false)
  })

  it("scopes tenant-targeted notes to the listed tenants only", () => {
    const u = { ...base, audienceType: "tenant", audienceConfig: { tenantIds: [7] } }
    expect(isUpdateVisibleTo(u, { tenantId: 7, role: "employee" })).toBe(true)
    expect(isUpdateVisibleTo(u, { tenantId: 8, role: "employee" })).toBe(false)
    expect(isUpdateVisibleTo(u, { tenantId: null, role: "admin" })).toBe(false)
  })

  it("matches role and plan audiences case-insensitively", () => {
    expect(isUpdateVisibleTo({ ...base, audienceType: "role", audienceConfig: { roles: ["Admin"] } }, { tenantId: 1, role: "admin" })).toBe(true)
    expect(isUpdateVisibleTo({ ...base, audienceType: "plan", audienceConfig: { plans: ["pro"] } }, { tenantId: 1, role: "admin", plan: null })).toBe(false)
  })

  it("rejects invalid input", () => {
    expect(() => validateUpdateInput({ version: "", title: "x", body: "y" })).toThrow()
    expect(() => validateUpdateInput({ version: "1.0.0", title: "x", body: "y", category: "rumor" })).toThrow()
  })

  it("validates idempotency keys", () => {
    expect(normalizeIdempotencyKey(null)).toBeNull()
    expect(normalizeIdempotencyKey("  ")).toBeNull()
    expect(normalizeIdempotencyKey("a1b2c3d4-e5")).toBe("a1b2c3d4-e5")
    expect(() => normalizeIdempotencyKey("short")).toThrow()
    expect(() => normalizeIdempotencyKey("bad key with spaces")).toThrow()
  })
})
