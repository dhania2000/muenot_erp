import { describe, expect, it } from "vitest"
import {
  parseScopeInput,
  resolveRiskScope,
  scopeKeyOf,
  RiskScopeError,
  RISK_SCOPE_DOMAIN,
} from "@/lib/risk-compliance/scope"

/**
 * Spec43 (#196-199, #207-208) — pure scope parsing + permission-scope
 * resolution for the risk & compliance dashboard. These decide which
 * group/company/branch/department view a caller may open, so their
 * correctness IS the tenant/permission boundary. No DB needed.
 */

const noGrantCtx = { assignedEntities: [], assignedBranches: [] }

describe("parseScopeInput — client input validation", () => {
  it("defaults blank/null to the group view", () => {
    expect(parseScopeInput(null, null)).toEqual({ level: "group", value: null })
    expect(parseScopeInput("", "")).toEqual({ level: "group", value: null })
    expect(parseScopeInput("group", "ignored")).toEqual({ level: "group", value: null })
  })

  it("accepts valid company/branch/department values", () => {
    expect(parseScopeInput("company", "Acme Pvt Ltd")).toEqual({ level: "company", value: "Acme Pvt Ltd" })
    expect(parseScopeInput("BRANCH", "  Mumbai HO  ")).toEqual({ level: "branch", value: "Mumbai HO" })
    expect(parseScopeInput("department", "Finance & Ops")).toEqual({ level: "department", value: "Finance & Ops" })
  })

  it("rejects an unknown level with a 400", () => {
    try {
      parseScopeInput("region", "x")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(RiskScopeError)
      expect((err as RiskScopeError).status).toBe(400)
    }
  })

  it("requires a value for non-group levels", () => {
    expect(() => parseScopeInput("company", "")).toThrow(/company value is required/)
    expect(() => parseScopeInput("branch", null)).toThrow(/branch value is required/)
  })

  it("rejects injection-y / oversized values", () => {
    expect(() => parseScopeInput("company", "Acme'; DROP TABLE x;--")).toThrow(RiskScopeError)
    expect(() => parseScopeInput("company", "<script>")).toThrow(RiskScopeError)
    expect(() => parseScopeInput("company", "a".repeat(151))).toThrow(RiskScopeError)
  })
})

describe("resolveRiskScope — intersect request with the caller's grant", () => {
  it("passes any scope through for an unrestricted (all / null) grant", () => {
    for (const kind of [null, "all"] as const) {
      const r = resolveRiskScope({ level: "company", value: "Acme" }, kind, noGrantCtx)
      expect(r).toMatchObject({ restricted: false, narrowed: false, allowed: null })
      expect(r.scope).toEqual({ level: "company", value: "Acme" })
    }
  })

  it("denies org-level views to none/self/team grants (403)", () => {
    for (const kind of ["none", "self", "team"] as const) {
      try {
        resolveRiskScope({ level: "group" }, kind, noGrantCtx)
        throw new Error("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(RiskScopeError)
        expect((err as RiskScopeError).status).toBe(403)
      }
    }
  })

  it("denies an entity/branch grant with no assignments (403)", () => {
    expect(() => resolveRiskScope({ level: "group" }, "entity", noGrantCtx)).toThrow(/No companies/)
    expect(() => resolveRiskScope({ level: "group" }, "branch", noGrantCtx)).toThrow(/No branches/)
  })

  it("narrows a broad request down to the first assigned company (entity grant)", () => {
    const ctx = { assignedEntities: ["Acme", "Globex"], assignedBranches: [] }
    const r = resolveRiskScope({ level: "group" }, "entity", ctx)
    expect(r).toMatchObject({ restricted: true, narrowed: true })
    expect(r.scope).toEqual({ level: "company", value: "Acme" })
    expect(r.allowed).toEqual({ level: "company", values: ["Acme", "Globex"] })
  })

  it("allows an in-grant company request without narrowing", () => {
    const ctx = { assignedEntities: ["Acme", "Globex"], assignedBranches: [] }
    const r = resolveRiskScope({ level: "company", value: "Globex" }, "entity", ctx)
    expect(r).toMatchObject({ restricted: true, narrowed: false })
    expect(r.scope).toEqual({ level: "company", value: "Globex" })
  })

  it("blocks a company OUTSIDE the entity grant (cross-scope escalation)", () => {
    const ctx = { assignedEntities: ["Acme"], assignedBranches: [] }
    try {
      resolveRiskScope({ level: "company", value: "Initech" }, "entity", ctx)
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(RiskScopeError)
      expect((err as RiskScopeError).status).toBe(403)
    }
  })

  it("blocks a department drill-down under an entity grant (containment unprovable)", () => {
    const ctx = { assignedEntities: ["Acme"], assignedBranches: [] }
    expect(() => resolveRiskScope({ level: "department", value: "HR" }, "entity", ctx)).toThrow(/only allows company-level/)
  })

  it("narrows a company request down to a branch for a branch grant", () => {
    const ctx = { assignedEntities: [], assignedBranches: ["Mumbai", "Pune"] }
    const r = resolveRiskScope({ level: "company", value: "Acme" }, "branch", ctx)
    expect(r).toMatchObject({ restricted: true, narrowed: true })
    expect(r.scope).toEqual({ level: "branch", value: "Mumbai" })
  })
})

describe("scopeKeyOf — stable cache key", () => {
  it("keys group and dimensioned scopes distinctly", () => {
    expect(scopeKeyOf({ level: "group" })).toBe("group")
    expect(scopeKeyOf({ level: "company", value: "Acme" })).toBe("company:Acme")
    expect(scopeKeyOf({ level: "branch", value: "Mumbai" })).toBe("branch:Mumbai")
  })

  it("exposes the risk.compliance data-scope domain constant", () => {
    expect(RISK_SCOPE_DOMAIN).toBe("risk.compliance")
  })
})
