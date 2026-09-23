import { describe, expect, it } from "vitest"
import {
  type FieldPolicyRule,
  type FieldSecurityActor,
  applyFieldSecurityToRow,
  effectRedactsValue,
  maskValue,
  moreRestrictiveEffect,
  policyMatchesActor,
  resolveFieldEffects,
  toFieldEffect,
  toFieldScopeType,
  toSensitiveCategory,
} from "@/lib/field-security-model"

// SPEC 70 — Field-Level Security. The enforcement decision is a pure function,
// so Phase 4 ("test unauthorized field access") is exhaustively verifiable here
// without a database: given policies + an actor, exactly which fields leak?

function rule(partial: Partial<FieldPolicyRule>): FieldPolicyRule {
  return {
    field: "salary",
    category: "salary",
    scopeType: "everyone",
    scopeValue: "",
    effect: "masked",
    enabled: true,
    ...partial,
  }
}

const employee: FieldSecurityActor = { role: "employee" }
const moduleAdmin: FieldSecurityActor = { role: "module_admin" }
const tenantAdmin: FieldSecurityActor = { role: "tenant_admin" }

describe("coercion helpers", () => {
  it("falls back to safe defaults for unknown input", () => {
    expect(toFieldEffect("nonsense")).toBe("masked")
    expect(toFieldEffect("hidden")).toBe("hidden")
    expect(toSensitiveCategory("nope")).toBe("generic")
    expect(toSensitiveCategory("pan")).toBe("pan")
    expect(toFieldScopeType("nope")).toBe("everyone")
    expect(toFieldScopeType("role")).toBe("role")
  })
})

describe("effect composition (most restrictive wins)", () => {
  it("orders effects least → most restrictive", () => {
    expect(moreRestrictiveEffect("visible", "read_only")).toBe("read_only")
    expect(moreRestrictiveEffect("read_only", "masked")).toBe("masked")
    expect(moreRestrictiveEffect("masked", "hidden")).toBe("hidden")
    expect(moreRestrictiveEffect("hidden", "visible")).toBe("hidden")
  })

  it("only masked and hidden redact a value on a read surface", () => {
    expect(effectRedactsValue("visible")).toBe(false)
    expect(effectRedactsValue("read_only")).toBe(false)
    expect(effectRedactsValue("masked")).toBe(true)
    expect(effectRedactsValue("hidden")).toBe(true)
  })
})

describe("maskValue is category-aware and non-reversible", () => {
  it("fully obscures money and internal financials (never leaks magnitude)", () => {
    expect(maskValue(1234567, "salary")).toBe("••••••")
    expect(maskValue(980000, "financial")).toBe("••••••")
  })

  it("reveals only the last 4 of an account number", () => {
    expect(maskValue("1234567890123456", "bank_account")).toBe("••••••••••••3456")
  })

  it("reveals only the last 4 of PAN / tax / Aadhaar", () => {
    expect(maskValue("ABCDE1234F", "pan")).toBe("XXXXXX234F")
    expect(maskValue("123456789012", "aadhaar")).toBe("XXXXXXXX9012")
  })

  it("reveals only the last 2 of a personal identifier", () => {
    expect(maskValue("9876543210", "personal_identifier")).toBe("••••••••10")
  })

  it("passes through null / empty (nothing to hide)", () => {
    expect(maskValue(null, "salary")).toBeNull()
    expect(maskValue("", "pan")).toBe("")
  })
})

describe("policyMatchesActor — scope targeting", () => {
  it("everyone matches every actor", () => {
    expect(policyMatchesActor(rule({ scopeType: "everyone" }), employee)).toBe(true)
    expect(policyMatchesActor(rule({ scopeType: "everyone" }), tenantAdmin)).toBe(true)
  })

  it("role scope means 'this role and below', never above", () => {
    const r = rule({ scopeType: "role", scopeValue: "module_admin" })
    expect(policyMatchesActor(r, employee)).toBe(true) // below → restricted
    expect(policyMatchesActor(r, moduleAdmin)).toBe(true) // exact → restricted
    expect(policyMatchesActor(r, tenantAdmin)).toBe(false) // above → NOT restricted
  })

  it("department / legal entity match case-insensitively and require the attribute", () => {
    const dept = rule({ scopeType: "department", scopeValue: "Finance" })
    expect(policyMatchesActor(dept, { role: "employee", department: "finance" })).toBe(true)
    expect(policyMatchesActor(dept, { role: "employee", department: "Sales" })).toBe(false)
    expect(policyMatchesActor(dept, { role: "employee" })).toBe(false) // unknown attribute → no match

    const le = rule({ scopeType: "legal_entity", scopeValue: "42" })
    expect(policyMatchesActor(le, { role: "employee", legalEntityId: 42 })).toBe(true)
    expect(policyMatchesActor(le, { role: "employee", legalEntityId: 7 })).toBe(false)
  })

  it("permission group matches any of the actor's groups", () => {
    const pg = rule({ scopeType: "permission_group", scopeValue: "AP Clerk" })
    expect(policyMatchesActor(pg, { role: "employee", permissionGroups: ["AP Clerk", "Viewer"] })).toBe(true)
    expect(policyMatchesActor(pg, { role: "employee", permissionGroups: ["Viewer"] })).toBe(false)
  })

  it("a disabled policy never matches", () => {
    expect(policyMatchesActor(rule({ enabled: false, scopeType: "everyone" }), employee)).toBe(false)
  })
})

describe("resolveFieldEffects — collapse many rules into one decision per field", () => {
  it("drops no-op visible outcomes", () => {
    const effects = resolveFieldEffects([rule({ field: "salary", effect: "visible" })], employee)
    expect(effects.has("salary")).toBe(false)
  })

  it("keeps only the most restrictive effect when rules overlap, with its category", () => {
    const effects = resolveFieldEffects(
      [
        rule({ field: "pan", category: "pan", effect: "masked" }),
        rule({ field: "pan", category: "pan", effect: "hidden" }),
      ],
      employee,
    )
    expect(effects.get("pan")).toEqual({ effect: "hidden", category: "pan" })
  })

  it("ignores rules that do not target the actor", () => {
    const effects = resolveFieldEffects(
      [rule({ field: "salary", scopeType: "role", scopeValue: "employee", effect: "hidden" })],
      tenantAdmin,
    )
    expect(effects.size).toBe(0)
  })
})

describe("applyFieldSecurityToRow — the actual redaction (Phase 4)", () => {
  const row = {
    id: 1,
    employee_name: "Asha",
    bank_account_number: "1234567890123456",
    bank_pan_number: "ABCDE1234F",
    salary: 1450000,
  }

  it("an unprivileged employee cannot read restricted fields", () => {
    const rules = [
      rule({ field: "salary", category: "salary", scopeType: "role", scopeValue: "module_admin", effect: "hidden" }),
      rule({ field: "bank_account_number", category: "bank_account", scopeType: "everyone", effect: "masked" }),
      rule({ field: "bank_pan_number", category: "pan", scopeType: "everyone", effect: "masked" }),
    ]
    const { row: safe, applied } = applyFieldSecurityToRow(row, resolveFieldEffects(rules, employee))

    // hidden → key removed entirely (no magnitude leak, not even the key)
    expect("salary" in safe).toBe(false)
    // masked → present but obscured
    expect(safe.bank_account_number).toBe("••••••••••••3456")
    expect(safe.bank_pan_number).toBe("XXXXXX234F")
    // untouched field survives
    expect(safe.employee_name).toBe("Asha")
    expect(applied.map((a) => a.field).sort()).toEqual(["bank_account_number", "bank_pan_number", "salary"])
  })

  it("a privileged actor above the role scope sees the real values", () => {
    const rules = [
      rule({ field: "salary", category: "salary", scopeType: "role", scopeValue: "module_admin", effect: "hidden" }),
    ]
    const { row: safe, applied } = applyFieldSecurityToRow(row, resolveFieldEffects(rules, tenantAdmin))
    expect(safe.salary).toBe(1450000)
    expect(applied).toHaveLength(0)
  })

  it("never mutates the input row", () => {
    const rules = [rule({ field: "salary", category: "salary", scopeType: "everyone", effect: "hidden" })]
    applyFieldSecurityToRow(row, resolveFieldEffects(rules, employee))
    expect(row.salary).toBe(1450000)
  })

  it("ignores fields not present on the row", () => {
    const rules = [rule({ field: "not_a_column", category: "generic", scopeType: "everyone", effect: "hidden" })]
    const { applied } = applyFieldSecurityToRow(row, resolveFieldEffects(rules, employee))
    expect(applied).toHaveLength(0)
  })
})
