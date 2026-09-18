import { describe, it, expect } from "vitest"
import {
  ABAC_ATTRIBUTE_CATALOG,
  abacBlocks,
  evaluateCondition,
  evaluatePolicies,
  policyAppliesToRequest,
  policyConditionsMatch,
  resolveDecision,
  sanitizeCondition,
  sanitizePolicyInput,
  type AbacCondition,
  type AbacEvalContext,
  type AbacPolicy,
} from "@/lib/abac-model"

/**
 * SPEC 9 — Phase 4. ABAC is an additive RESTRICTION layer on top of RBAC, so
 * the whole value of the feature rests on the combining engine resolving
 * overlapping policies deterministically and fail-safe. These tests pin the
 * pure model (no DB / server-only imports) so a change to condition
 * evaluation, scope matching, conflict resolution or precedence can never
 * silently widen or narrow enterprise access.
 */

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

let idSeq = 0
function policy(overrides: Partial<AbacPolicy> = {}): AbacPolicy {
  idSeq += 1
  return {
    id: idSeq,
    name: `policy-${idSeq}`,
    effect: "deny",
    priority: 0,
    enabled: true,
    modules: ["*"],
    actions: ["*"],
    combine: "all",
    conditions: [],
    ...overrides,
  }
}

const ctx = (subject: any = {}, resource: any = {}, environment: any = {}): AbacEvalContext => ({
  subject,
  resource,
  environment,
})

// ---------------------------------------------------------------------------
// Scope matching — module + action patterns (exact, group.*, *).
// ---------------------------------------------------------------------------

describe("policyAppliesToRequest — module/action scoping", () => {
  it("matches the wildcard module and action", () => {
    const p = policy({ modules: ["*"], actions: ["*"] })
    expect(policyAppliesToRequest(p, { module: "finance.expenses", action: "edit" })).toBe(true)
  })

  it("matches an exact module + action", () => {
    const p = policy({ modules: ["finance.expenses"], actions: ["approve"] })
    expect(policyAppliesToRequest(p, { module: "finance.expenses", action: "approve" })).toBe(true)
    expect(policyAppliesToRequest(p, { module: "finance.expenses", action: "edit" })).toBe(false)
    expect(policyAppliesToRequest(p, { module: "finance.invoices", action: "approve" })).toBe(false)
  })

  it("matches a group prefix pattern (finance.*)", () => {
    const p = policy({ modules: ["finance.*"], actions: ["*"] })
    expect(policyAppliesToRequest(p, { module: "finance.expenses", action: "view" })).toBe(true)
    expect(policyAppliesToRequest(p, { module: "finance", action: "view" })).toBe(true)
    expect(policyAppliesToRequest(p, { module: "hr.employees", action: "view" })).toBe(false)
  })

  it("never applies a disabled policy", () => {
    const p = policy({ enabled: false, modules: ["*"], actions: ["*"] })
    expect(policyAppliesToRequest(p, { module: "anything", action: "view" })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Condition evaluation — the value comparisons policies are built from.
// ---------------------------------------------------------------------------

describe("evaluateCondition — operators", () => {
  const cond = (c: Partial<AbacCondition>): AbacCondition => ({
    target: "resource",
    attribute: "department",
    operator: "eq",
    operand: { kind: "attribute", target: "subject", attribute: "department" },
    ...c,
  })

  it("eq compares case-insensitively and requires both sides present", () => {
    expect(evaluateCondition(cond({}), ctx({ department: "Finance" }, { department: "finance" }))).toBe(true)
    expect(evaluateCondition(cond({}), ctx({ department: "HR" }, { department: "finance" }))).toBe(false)
    // Missing left (resource) attribute -> false, never throws.
    expect(evaluateCondition(cond({}), ctx({ department: "finance" }, {}))).toBe(false)
  })

  it("eq against a literal value", () => {
    const c = cond({ operator: "eq", operand: { kind: "literal", value: "restricted" }, attribute: "data_classification" })
    expect(evaluateCondition(c, ctx({}, { data_classification: "restricted" }))).toBe(true)
    expect(evaluateCondition(c, ctx({}, { data_classification: "public" }))).toBe(false)
  })

  it("ne treats an absent left as not-equal when the right is present", () => {
    const c = cond({ operator: "ne", operand: { kind: "literal", value: "finance" } })
    expect(evaluateCondition(c, ctx({}, { department: "hr" }))).toBe(true)
    expect(evaluateCondition(c, ctx({}, {}))).toBe(true)
    expect(evaluateCondition(c, ctx({}, { department: "finance" }))).toBe(false)
  })

  it("in tests membership of the left value inside a set literal", () => {
    const c = cond({ attribute: "branch", operator: "in", operand: { kind: "literal", value: ["mumbai", "delhi"] } })
    expect(evaluateCondition(c, ctx({}, { branch: "Delhi" }))).toBe(true)
    expect(evaluateCondition(c, ctx({}, { branch: "chennai" }))).toBe(false)
  })

  it("manager-hierarchy: resource.owner_id in subject.manager_chain (set membership)", () => {
    const c = cond({
      target: "resource",
      attribute: "owner_id",
      operator: "in",
      operand: { kind: "attribute", target: "subject", attribute: "manager_chain" },
    })
    expect(evaluateCondition(c, ctx({ manager_chain: [11, 12, 13] }, { owner_id: 12 }))).toBe(true)
    expect(evaluateCondition(c, ctx({ manager_chain: [11, 12, 13] }, { owner_id: 99 }))).toBe(false)
    // Empty chain -> nobody matches.
    expect(evaluateCondition(c, ctx({ manager_chain: [] }, { owner_id: 12 }))).toBe(false)
  })

  it("amount threshold: numeric gt/gte/lt/lte", () => {
    const gt = cond({ attribute: "amount", operator: "gt", operand: { kind: "literal", value: 50000 } })
    expect(evaluateCondition(gt, ctx({}, { amount: 50001 }))).toBe(true)
    expect(evaluateCondition(gt, ctx({}, { amount: 50000 }))).toBe(false)
    const lte = cond({ attribute: "amount", operator: "lte", operand: { kind: "literal", value: 50000 } })
    expect(evaluateCondition(lte, ctx({}, { amount: 50000 }))).toBe(true)
    expect(evaluateCondition(lte, ctx({}, { amount: 50001 }))).toBe(false)
  })

  it("ordinal data-classification compares through its scale, not string order", () => {
    // "confidential" (rank 2) > "internal" (rank 1) even though 'c' < 'i'.
    const c = cond({
      target: "resource",
      attribute: "data_classification",
      operator: "gt",
      operand: { kind: "attribute", target: "subject", attribute: "data_classification" },
    })
    expect(evaluateCondition(c, ctx({ data_classification: "internal" }, { data_classification: "confidential" }))).toBe(true)
    expect(evaluateCondition(c, ctx({ data_classification: "secret" }, { data_classification: "confidential" }))).toBe(false)
  })

  it("ordinal employee-level: subject clearance ≥ required literal", () => {
    const c = cond({
      target: "subject",
      attribute: "employee_level",
      operator: "gte",
      operand: { kind: "literal", value: "manager" },
    })
    expect(evaluateCondition(c, ctx({ employee_level: "director" }))).toBe(true)
    expect(evaluateCondition(c, ctx({ employee_level: "manager" }))).toBe(true)
    expect(evaluateCondition(c, ctx({ employee_level: "junior" }))).toBe(false)
  })

  it("unknown ordinal values rank fail-safe (comparison is false)", () => {
    const c = cond({
      target: "subject",
      attribute: "employee_level",
      operator: "gte",
      operand: { kind: "literal", value: "manager" },
    })
    expect(evaluateCondition(c, ctx({ employee_level: "not-a-level" }))).toBe(false)
  })
})

describe("policyConditionsMatch — all vs any", () => {
  const sameDept: AbacCondition = {
    target: "resource",
    attribute: "department",
    operator: "eq",
    operand: { kind: "attribute", target: "subject", attribute: "department" },
  }
  const highAmount: AbacCondition = {
    target: "resource",
    attribute: "amount",
    operator: "gt",
    operand: { kind: "literal", value: 50000 },
  }

  it("an unconditional policy always matches its scope", () => {
    expect(policyConditionsMatch(policy({ conditions: [] }), ctx())).toBe(true)
  })

  it("combine=all requires every condition (AND)", () => {
    const p = policy({ combine: "all", conditions: [sameDept, highAmount] })
    expect(policyConditionsMatch(p, ctx({ department: "finance" }, { department: "finance", amount: 60000 }))).toBe(true)
    expect(policyConditionsMatch(p, ctx({ department: "finance" }, { department: "finance", amount: 100 }))).toBe(false)
  })

  it("combine=any requires only one condition (OR)", () => {
    const p = policy({ combine: "any", conditions: [sameDept, highAmount] })
    expect(policyConditionsMatch(p, ctx({ department: "hr" }, { department: "finance", amount: 60000 }))).toBe(true)
    expect(policyConditionsMatch(p, ctx({ department: "hr" }, { department: "finance", amount: 100 }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase 4 — conflict resolution + precedence (the combining algorithms).
// ---------------------------------------------------------------------------

describe("evaluatePolicies — combining algorithms & precedence", () => {
  const req = { module: "finance.expenses", action: "approve" }
  const permit = policy({ name: "permit-all", effect: "permit", priority: 1 })
  const deny = policy({ name: "deny-all", effect: "deny", priority: 1 })

  it("returns not_applicable when no policy matches", () => {
    const r = evaluatePolicies([policy({ modules: ["hr.*"] })], req, ctx())
    expect(r.decision).toBe("not_applicable")
    expect(r.decidingPolicy).toBeNull()
  })

  it("deny-overrides: any matched deny beats any permit (default, safest)", () => {
    const r = evaluatePolicies([permit, deny], req, ctx(), "deny-overrides")
    expect(r.decision).toBe("deny")
    expect(r.decidingPolicy?.effect).toBe("deny")
  })

  it("permit-overrides: any matched permit beats any deny", () => {
    const r = evaluatePolicies([permit, deny], req, ctx(), "permit-overrides")
    expect(r.decision).toBe("permit")
    expect(r.decidingPolicy?.effect).toBe("permit")
  })

  it("priority: the highest-priority matched policy decides", () => {
    const lowPermit = policy({ name: "low-permit", effect: "permit", priority: 1 })
    const highDeny = policy({ name: "high-deny", effect: "deny", priority: 10 })
    expect(evaluatePolicies([lowPermit, highDeny], req, ctx(), "priority").decision).toBe("deny")

    const highPermit = policy({ name: "high-permit", effect: "permit", priority: 10 })
    const lowDeny = policy({ name: "low-deny", effect: "deny", priority: 1 })
    expect(evaluatePolicies([highPermit, lowDeny], req, ctx(), "priority").decision).toBe("permit")
  })

  it("priority: ties break deny-over-permit for safety", () => {
    const tiedPermit = policy({ name: "tied-permit", effect: "permit", priority: 5 })
    const tiedDeny = policy({ name: "tied-deny", effect: "deny", priority: 5 })
    expect(evaluatePolicies([tiedPermit, tiedDeny], req, ctx(), "priority").decision).toBe("deny")
  })

  it("first-applicable: highest priority (then id) decides, order-independent", () => {
    const first = policy({ name: "first", effect: "permit", priority: 10 })
    const second = policy({ name: "second", effect: "deny", priority: 5 })
    expect(evaluatePolicies([second, first], req, ctx(), "first-applicable").decidingPolicy?.name).toBe("first")
  })

  it("only counts policies whose conditions ALSO match", () => {
    const conditionalDeny = policy({
      name: "conditional-deny",
      effect: "deny",
      priority: 100,
      conditions: [{ target: "resource", attribute: "amount", operator: "gt", operand: { kind: "literal", value: 50000 } }],
    })
    // Amount below threshold -> the deny does not match -> permit wins.
    const below = evaluatePolicies([permit, conditionalDeny], req, ctx({}, { amount: 100 }), "deny-overrides")
    expect(below.decision).toBe("permit")
    // Amount above threshold -> the deny matches -> deny wins.
    const above = evaluatePolicies([permit, conditionalDeny], req, ctx({}, { amount: 60000 }), "deny-overrides")
    expect(above.decision).toBe("deny")
    expect(above.matched.map((m) => m.name).sort()).toEqual(["conditional-deny", "permit-all"])
  })
})

// ---------------------------------------------------------------------------
// resolveDecision / abacBlocks — the non-breaking bridge to enforcement.
// ---------------------------------------------------------------------------

describe("resolveDecision & abacBlocks — additive restriction semantics", () => {
  const req = { module: "finance.expenses", action: "approve" }

  it("no matching policy does NOT block (RBAC-only behaviour preserved)", () => {
    const { blocked } = abacBlocks([], req, ctx())
    expect(blocked).toBe(false)
  })

  it("resolveDecision honours the not_applicable default posture", () => {
    const naResult = evaluatePolicies([policy({ modules: ["hr.*"] })], req, ctx())
    expect(resolveDecision(naResult, "permit")).toBe(true) // default-allow
    expect(resolveDecision(naResult, "deny")).toBe(false) // default-deny
  })

  it("a matched deny blocks; a matched permit does not", () => {
    const deny = policy({ effect: "deny" })
    expect(abacBlocks([deny], req, ctx()).blocked).toBe(true)
    const permit = policy({ effect: "permit" })
    expect(abacBlocks([permit], req, ctx()).blocked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Input validation — bad policies must never persist.
// ---------------------------------------------------------------------------

describe("sanitizeCondition / sanitizePolicyInput — validation", () => {
  it("accepts a well-formed attribute-reference condition", () => {
    const c = sanitizeCondition({
      target: "resource",
      attribute: "department",
      operator: "eq",
      operand: { kind: "attribute", target: "subject", attribute: "department" },
    })
    expect(c).not.toBeNull()
  })

  it("rejects unknown targets, operators and malformed operands", () => {
    expect(sanitizeCondition({ target: "nope", attribute: "x", operator: "eq", operand: { kind: "literal", value: 1 } })).toBeNull()
    expect(sanitizeCondition({ target: "resource", attribute: "x", operator: "??", operand: { kind: "literal", value: 1 } })).toBeNull()
    expect(sanitizeCondition({ target: "resource", attribute: "", operator: "eq", operand: { kind: "literal", value: 1 } })).toBeNull()
    expect(sanitizeCondition({ target: "resource", attribute: "x", operator: "eq", operand: { kind: "literal", value: {} } })).toBeNull()
  })

  it("rejects a policy with no name or an invalid effect", () => {
    expect(sanitizePolicyInput({ name: "", effect: "deny" })).toBeNull()
    expect(sanitizePolicyInput({ name: "x", effect: "maybe" })).toBeNull()
  })

  it("rejects the whole policy if ANY condition is invalid (fail-closed)", () => {
    const bad = sanitizePolicyInput({
      name: "mixed",
      effect: "deny",
      conditions: [
        { target: "resource", attribute: "department", operator: "eq", operand: { kind: "literal", value: "finance" } },
        { target: "bogus", attribute: "x", operator: "eq", operand: { kind: "literal", value: 1 } },
      ],
    })
    expect(bad).toBeNull()
  })

  it("normalizes empty module/action lists to the wildcard", () => {
    const clean = sanitizePolicyInput({ name: "wide", effect: "permit", modules: [], actions: [] })
    expect(clean?.modules).toEqual(["*"])
    expect(clean?.actions).toEqual(["*"])
    expect(clean?.enabled).toBe(true)
    expect(clean?.combine).toBe("all")
  })
})

// ---------------------------------------------------------------------------
// Attribute catalog integrity — the vocabulary the whole feature trusts.
// ---------------------------------------------------------------------------

describe("attribute catalog integrity", () => {
  it("covers every SPEC-9 required attribute", () => {
    const keys = new Set(ABAC_ATTRIBUTE_CATALOG.map((a) => a.key))
    for (const required of [
      "department",
      "branch",
      "entity",
      "location",
      "manager_chain",
      "employee_level",
      "data_classification",
      "amount",
      "project",
      "cost_center",
      "geography",
    ]) {
      expect(keys.has(required as any), required).toBe(true)
    }
  })

  it("gives every ordinal attribute a scale to compare through", () => {
    for (const a of ABAC_ATTRIBUTE_CATALOG) {
      if (a.kind === "ordinal") {
        expect(a.ordinalScale && a.ordinalScale.length > 0, a.key).toBe(true)
      }
    }
  })
})
