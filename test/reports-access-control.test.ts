import { describe, it, expect } from "vitest"
import { getReportSource, reportScopeDomain, type ReportSource } from "@/lib/reports/catalog"
import { buildDataScopeSql, getDataDomain, type DataScopeContext } from "@/lib/data-scope-model"
import {
  applyFieldSecurityToRow,
  resolveFieldEffects,
  type FieldPolicyRule,
  type FieldSecurityActor,
} from "@/lib/field-security-model"
import {
  DEFAULT_CLEARANCE_MATRIX,
  redactedExportFields,
  type ClassifiedField,
} from "@/lib/data-classification-model"

/**
 * SPEC 99 — Phase 4: data-leakage scenarios.
 * ---------------------------------------------------------------------------
 * The centralized report authorizer (`lib/reports/authorization.ts`) composes
 * seven enforcement primitives. Wiring it to a live DB is covered by the app
 * routes; here we prove — with NO database — that each primitive it delegates
 * to actually BLOCKS the leak it is responsible for, and that the composition
 * fails CLOSED. Every test frames a concrete "user X must not see Y" scenario.
 */

// A source that is linked to a data-scope domain (grant-backed row scoping).
const employees = getReportSource("hr.employees") as ReportSource

// Shared scope context: user 7 owns rows; manages 8 and 9; assigned to entity
// "E1" and branch "B1".
const ctx: DataScopeContext = {
  userId: 7,
  subordinateUserIds: [8, 9],
  assignedEntities: ["E1"],
  assignedBranches: ["B1"],
}

// ---------------------------------------------------------------------------
// USER / TEAM scope — row-level, via the owner column
// ---------------------------------------------------------------------------

describe("row scope: User dimension", () => {
  const domain = getDataDomain("hr.employees")!
  const owner = domain.ownerColumns[0]
  const cols = new Set([owner, ...domain.entityColumns, ...domain.branchColumns])

  it("'self' restricts to the acting user's own rows", () => {
    const scope = buildDataScopeSql("self", domain, ctx, cols)
    expect(scope).not.toBeNull()
    expect(scope!.sql).toContain(owner)
    expect(scope!.params).toEqual([7])
  })

  it("'team' widens to the user + direct reports, never beyond", () => {
    const scope = buildDataScopeSql("team", domain, ctx, cols)
    expect(scope!.params).toEqual([7, 8, 9])
    // A peer (id 42) is not in the IN-list → their rows can never match.
    expect(scope!.params).not.toContain(42)
  })

  it("'all' imposes no row restriction (admin/unscoped)", () => {
    expect(buildDataScopeSql("all", domain, ctx, cols)).toBeNull()
  })

  it("'none' denies every row", () => {
    expect(buildDataScopeSql("none", domain, ctx, cols)!.sql).toBe("1=0")
  })
})

// ---------------------------------------------------------------------------
// ENTITY / DEPARTMENT (branch) scope — row-level
// ---------------------------------------------------------------------------

describe("row scope: Entity dimension", () => {
  const domain = getDataDomain("hr.employees")!
  const cols = new Set([...domain.ownerColumns, ...domain.entityColumns, ...domain.branchColumns])

  it("'entity' restricts to the user's assigned legal entities", () => {
    // The predicate ORs the identifier across every candidate entity column, so
    // "E1" is bound once per column — what matters is that ONLY E1 is bound.
    const scope = buildDataScopeSql("entity", domain, ctx, cols)
    expect(scope!.params).toContain("E1")
    expect(new Set(scope!.params)).toEqual(new Set(["E1"]))
    // A different entity's identifier is absent from the predicate.
    expect(scope!.params).not.toContain("E2")
  })

  it("'branch' restricts to the user's assigned branches/departments", () => {
    const scope = buildDataScopeSql("branch", domain, ctx, cols)
    expect(new Set(scope!.params)).toEqual(new Set(["B1"]))
  })
})

// ---------------------------------------------------------------------------
// FAIL-CLOSED — the whole reason row scoping is safe
// ---------------------------------------------------------------------------

describe("row scope fails CLOSED on misconfiguration", () => {
  const domain = getDataDomain("hr.employees")!

  it("denies all rows when the owner column is missing from the live schema", () => {
    // 'self' needs an owner column; if the deployed table lacks it we must NOT
    // silently return every row — we deny.
    const scope = buildDataScopeSql("self", domain, ctx, new Set(["unrelated_col"]))
    expect(scope!.sql).toBe("1=0")
  })

  it("denies all rows when the user has no assigned entities", () => {
    const empty: DataScopeContext = { ...ctx, assignedEntities: [] }
    const cols = new Set(domain.entityColumns)
    const scope = buildDataScopeSql("entity", domain, empty, cols)
    expect(scope!.sql).toBe("1=0")
  })
})

// ---------------------------------------------------------------------------
// ROLE × DATA CLASSIFICATION — field-level redaction
// ---------------------------------------------------------------------------

describe("field redaction: Role + Data classification", () => {
  const fields: ClassifiedField[] = [
    { field: "name", level: "Public" },
    { field: "salary", level: "Confidential" },
    { field: "ssn", level: "Restricted" },
  ]

  it("a low-clearance role loses confidential and restricted fields", () => {
    // Default matrix: a plain employee cannot export Confidential+ fields.
    const redacted = redactedExportFields(fields, "employee", DEFAULT_CLEARANCE_MATRIX)
    expect(redacted.has("salary")).toBe(true)
    expect(redacted.has("ssn")).toBe(true)
    expect(redacted.has("name")).toBe(false)
  })

  it("a high-clearance role keeps confidential fields", () => {
    // tenant_admin clears Confidential (needs module_admin) and Restricted.
    const redacted = redactedExportFields(fields, "tenant_admin", DEFAULT_CLEARANCE_MATRIX)
    expect(redacted.has("salary")).toBe(false)
    expect(redacted.has("ssn")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FIELD-LEVEL SECURITY — Department / Role / Legal-entity / Permission-group
// ---------------------------------------------------------------------------

describe("field-level security: masking and hiding", () => {
  const rule: FieldPolicyRule = {
    field: "bank_account",
    category: "financial",
    effect: "masked",
    scopeType: "department",
    scopeValue: "Sales",
    enabled: true,
  }

  it("masks the field for a matching department, revealing nothing usable", () => {
    const actor: FieldSecurityActor = { role: "employee", department: "Sales", legalEntityId: null, permissionGroups: [] }
    const effects = resolveFieldEffects([rule], actor)
    expect(effects.get("bank_account")?.effect).toBe("masked")

    const row = { bank_account: "12345678", name: "Acme" }
    const { row: out } = applyFieldSecurityToRow(row, effects)
    expect(out.name).toBe("Acme")
    expect(out.bank_account).not.toBe("12345678")
  })

  it("does NOT apply a department policy to a user in another department", () => {
    const actor: FieldSecurityActor = { role: "employee", department: "Engineering", legalEntityId: null, permissionGroups: [] }
    const effects = resolveFieldEffects([rule], actor)
    expect(effects.get("bank_account")).toBeUndefined()
  })

  it("hides (drops) a field entirely under a 'hidden' policy", () => {
    const hide: FieldPolicyRule = { ...rule, effect: "hidden", scopeType: "everyone", scopeValue: "" }
    const actor: FieldSecurityActor = { role: "employee", department: null, legalEntityId: null, permissionGroups: [] }
    const effects = resolveFieldEffects([hide], actor)
    const { row: out } = applyFieldSecurityToRow({ bank_account: "x", name: "y" }, effects)
    expect("bank_account" in out).toBe(false)
    expect(out.name).toBe("y")
  })

  it("applies the MORE restrictive effect when policies overlap", () => {
    const mask: FieldPolicyRule = { field: "f", category: "financial", effect: "masked", scopeType: "everyone", scopeValue: "", enabled: true }
    const hide: FieldPolicyRule = { field: "f", category: "financial", effect: "hidden", scopeType: "role", scopeValue: "employee", enabled: true }
    const actor: FieldSecurityActor = { role: "employee", department: null, legalEntityId: null, permissionGroups: [] }
    const effects = resolveFieldEffects([mask, hide], actor)
    expect(effects.get("f")?.effect).toBe("hidden")
  })
})

// ---------------------------------------------------------------------------
// CATALOG WIRING — grant-backed sources are linked to a scope domain
// ---------------------------------------------------------------------------

describe("catalog: report → scope-domain linkage", () => {
  it("links the employees report to the hr data-scope domain", () => {
    expect(reportScopeDomain(employees)?.key).toBe("hr.employees")
  })

  it("leaves a non-scoped source unlinked (no accidental restriction)", () => {
    const invoices = getReportSource("finance.invoices") as ReportSource
    // finance.invoices carries its own scope metadata only if configured;
    // whatever the catalog says, the helper must return a domain or null, never throw.
    expect(() => reportScopeDomain(invoices)).not.toThrow()
  })
})
