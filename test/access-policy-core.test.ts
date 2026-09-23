import { describe, expect, it } from "vitest"
import {
  type AccessPolicy,
  type PolicyContext,
  evaluateAccessPolicies,
  evaluateCondition,
  policyMatches,
} from "@/lib/access-policy-core"

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Policy",
    priority: overrides.priority ?? 100,
    scope: overrides.scope ?? "Tenant",
    conditions: overrides.conditions ?? [{ id: "c1", field: "Role", operator: "=", value: "employee" }],
    combinator: overrides.combinator ?? "AND",
    effect: overrides.effect ?? "Deny",
    enabled: overrides.enabled ?? true,
  }
}

const NOON = new Date("2026-01-01T12:00:00")

describe("evaluateCondition", () => {
  const ctx: PolicyContext = {
    userId: 5,
    email: "user@example.test",
    tenantRole: "employee",
    ip: "203.0.113.10",
    country: "US",
    mfaEnabled: false,
    deviceTrusted: false,
  }

  it("matches role equality case-insensitively", () => {
    expect(evaluateCondition({ id: "c", field: "Role", operator: "=", value: "Employee" }, ctx, NOON)).toBe(true)
    expect(evaluateCondition({ id: "c", field: "Role", operator: "!=", value: "employee" }, ctx, NOON)).toBe(false)
  })

  it("matches an IP inside a CIDR range", () => {
    expect(evaluateCondition({ id: "c", field: "IP condition", operator: "=", value: "203.0.113.0/24" }, ctx, NOON)).toBe(true)
    expect(evaluateCondition({ id: "c", field: "IP condition", operator: "!=", value: "10.0.0.0/8" }, ctx, NOON)).toBe(true)
  })

  it("supports comma lists for in / not in", () => {
    expect(evaluateCondition({ id: "c", field: "Country", operator: "in", value: "GB, US, DE" }, ctx, NOON)).toBe(true)
    expect(evaluateCondition({ id: "c", field: "Country", operator: "not in", value: "GB, DE" }, ctx, NOON)).toBe(true)
  })

  it("evaluates MFA and device-trust state", () => {
    expect(evaluateCondition({ id: "c", field: "MFA state", operator: "=", value: "disabled" }, ctx, NOON)).toBe(true)
    expect(evaluateCondition({ id: "c", field: "Device trust", operator: "=", value: "unknown" }, ctx, NOON)).toBe(true)
  })

  it("does not match when required data is unavailable", () => {
    const bare: PolicyContext = { tenantRole: "employee" }
    expect(evaluateCondition({ id: "c", field: "Device trust", operator: "=", value: "unknown" }, bare, NOON)).toBe(false)
    expect(evaluateCondition({ id: "c", field: "Session age", operator: "=", value: "60" }, bare, NOON)).toBe(false)
    expect(evaluateCondition({ id: "c", field: "Module", operator: "=", value: "hr" }, bare, NOON)).toBe(false)
  })

  it("evaluates time windows including overnight ranges", () => {
    expect(evaluateCondition({ id: "c", field: "Time window", operator: "in", value: "09:00-17:00" }, ctx, NOON)).toBe(true)
    const night = new Date("2026-01-01T23:30:00")
    expect(evaluateCondition({ id: "c", field: "Time window", operator: "in", value: "22:00-06:00" }, ctx, night)).toBe(true)
  })
})

describe("policyMatches", () => {
  const ctx: PolicyContext = { tenantRole: "employee", country: "US", ip: "203.0.113.10" }

  it("requires all conditions with AND", () => {
    const p = policy({
      combinator: "AND",
      conditions: [
        { id: "1", field: "Role", operator: "=", value: "employee" },
        { id: "2", field: "Country", operator: "=", value: "GB" },
      ],
    })
    expect(policyMatches(p, ctx, NOON)).toBe(false)
  })

  it("requires any condition with OR", () => {
    const p = policy({
      combinator: "OR",
      conditions: [
        { id: "1", field: "Role", operator: "=", value: "employee" },
        { id: "2", field: "Country", operator: "=", value: "GB" },
      ],
    })
    expect(policyMatches(p, ctx, NOON)).toBe(true)
  })

  it("ignores conditions with empty values", () => {
    const p = policy({ conditions: [{ id: "1", field: "Role", operator: "=", value: "" }] })
    expect(policyMatches(p, ctx, NOON)).toBe(false)
  })
})

describe("evaluateAccessPolicies", () => {
  const ctx: PolicyContext = { tenantRole: "employee", country: "US", ip: "198.51.100.5", mfaEnabled: false }

  it("denies when a matching Deny policy applies", () => {
    const result = evaluateAccessPolicies(
      [policy({ effect: "Deny", conditions: [{ id: "1", field: "Country", operator: "!=", value: "US" }] })],
      { ...ctx, country: "RU" },
      NOON,
    )
    expect(result.denied).toBe(true)
    expect(result.deniedByPolicy).toBe("Policy")
  })

  it("collects Require MFA obligations without denying", () => {
    const result = evaluateAccessPolicies(
      [policy({ effect: "Require MFA", conditions: [{ id: "1", field: "Role", operator: "=", value: "employee" }] })],
      ctx,
      NOON,
    )
    expect(result.denied).toBe(false)
    expect(result.requireMfa).toBe(true)
  })

  it("lets the lowest-priority Allow settle the decision before a later Deny", () => {
    const allow = policy({ id: "a", name: "Allow trusted net", priority: 10, effect: "Allow", conditions: [{ id: "1", field: "IP condition", operator: "=", value: "198.51.100.0/24" }] })
    const deny = policy({ id: "d", name: "Deny employees", priority: 20, effect: "Deny", conditions: [{ id: "2", field: "Role", operator: "=", value: "employee" }] })
    const result = evaluateAccessPolicies([deny, allow], ctx, NOON)
    expect(result.denied).toBe(false)
  })

  it("skips disabled policies", () => {
    const result = evaluateAccessPolicies(
      [policy({ effect: "Deny", enabled: false, conditions: [{ id: "1", field: "Role", operator: "=", value: "employee" }] })],
      ctx,
      NOON,
    )
    expect(result.denied).toBe(false)
    expect(result.matched).toHaveLength(0)
  })
})
