import { describe, it, expect } from "vitest"
import {
  type ApprovalRuleDef,
  type ApprovalContext,
  type RequestStepState,
  type Delegation,
  type OverdueStep,
  ruleMatches,
  ruleSpecificity,
  selectRule,
  buildChain,
  evaluateLevel,
  evaluateRequest,
  activeLevelNo,
  resolveDelegate,
  computeEscalations,
} from "@/lib/approval-authority-core"

/**
 * Phase 4. Exhaustive, DB-free proof that the configurable approval
 * authority behaves correctly for every capability the spec requires:
 * amount / department / role / entity matching, rule selection precedence,
 * multi-level sequential chains, parallel level modes (all / any / quorum),
 * delegation (including cycles), and time-based escalation.
 *
 * The engine under test is pure (lib/approval-authority-core.ts), so the whole
 * decision surface is exercised deterministically here.
 */

function rule(partial: Partial<ApprovalRuleDef>): ApprovalRuleDef {
  return {
    id: 1,
    name: "rule",
    moduleKey: "*",
    active: true,
    priority: 0,
    conditions: {},
    levels: [],
    ...partial,
  }
}

const ctx = (partial: Partial<ApprovalContext>): ApprovalContext => ({ moduleKey: "finance.expenses", ...partial })

// ---------------------------------------------------------------------------
// Rule matching — amount / department / role / entity
// ---------------------------------------------------------------------------

describe("ruleMatches", () => {
  it("matches on module, treating '*' as a wildcard", () => {
    expect(ruleMatches(rule({ moduleKey: "finance.expenses" }), ctx({}))).toBe(true)
    expect(ruleMatches(rule({ moduleKey: "hr.leave" }), ctx({}))).toBe(false)
    expect(ruleMatches(rule({ moduleKey: "*" }), ctx({}))).toBe(true)
  })

  it("never matches an inactive rule", () => {
    expect(ruleMatches(rule({ active: false }), ctx({}))).toBe(false)
  })

  it("applies inclusive amount bounds (amount-based approval)", () => {
    const r = rule({ conditions: { minAmount: 1000, maxAmount: 5000 } })
    expect(ruleMatches(r, ctx({ amount: 999 }))).toBe(false)
    expect(ruleMatches(r, ctx({ amount: 1000 }))).toBe(true)
    expect(ruleMatches(r, ctx({ amount: 5000 }))).toBe(true)
    expect(ruleMatches(r, ctx({ amount: 5001 }))).toBe(false)
  })

  it("treats a missing amount as 0 for bound checks", () => {
    expect(ruleMatches(rule({ conditions: { minAmount: 1 } }), ctx({ amount: null }))).toBe(false)
    expect(ruleMatches(rule({ conditions: { maxAmount: 10 } }), ctx({ amount: null }))).toBe(true)
  })

  it("matches department case-insensitively (department-based approval)", () => {
    const r = rule({ conditions: { department: "Finance" } })
    expect(ruleMatches(r, ctx({ department: "finance" }))).toBe(true)
    expect(ruleMatches(r, ctx({ department: "Sales" }))).toBe(false)
  })

  it("matches requester role (role-based approval)", () => {
    const r = rule({ conditions: { role: "Manager" } })
    expect(ruleMatches(r, ctx({ role: "manager" }))).toBe(true)
    expect(ruleMatches(r, ctx({ role: "Analyst" }))).toBe(false)
  })

  it("matches legal entity (entity-based approval)", () => {
    const r = rule({ conditions: { entityId: 7 } })
    expect(ruleMatches(r, ctx({ entityId: 7 }))).toBe(true)
    expect(ruleMatches(r, ctx({ entityId: 9 }))).toBe(false)
    expect(ruleMatches(r, ctx({ entityId: null }))).toBe(false)
  })

  it("requires ALL set conditions to hold at once", () => {
    const r = rule({ conditions: { department: "Finance", minAmount: 1000, entityId: 3 } })
    expect(ruleMatches(r, ctx({ department: "Finance", amount: 2000, entityId: 3 }))).toBe(true)
    expect(ruleMatches(r, ctx({ department: "Finance", amount: 500, entityId: 3 }))).toBe(false)
    expect(ruleMatches(r, ctx({ department: "Finance", amount: 2000, entityId: 4 }))).toBe(false)
  })
})

describe("ruleSpecificity", () => {
  it("counts the number of pinned conditions", () => {
    expect(ruleSpecificity(rule({ conditions: {} }))).toBe(0)
    expect(ruleSpecificity(rule({ conditions: { department: "Finance" } }))).toBe(1)
    expect(
      ruleSpecificity(rule({ conditions: { department: "Finance", minAmount: 1, maxAmount: 2, role: "x", entityId: 3 } })),
    ).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Rule selection precedence
// ---------------------------------------------------------------------------

describe("selectRule", () => {
  it("returns null when nothing matches", () => {
    expect(selectRule([rule({ moduleKey: "hr.leave" })], ctx({}))).toBeNull()
  })

  it("prefers a module-specific rule over a wildcard rule", () => {
    const wild = rule({ id: 1, moduleKey: "*" })
    const specific = rule({ id: 2, moduleKey: "finance.expenses" })
    expect(selectRule([wild, specific], ctx({}))?.id).toBe(2)
  })

  it("prefers higher priority", () => {
    const low = rule({ id: 1, priority: 10 })
    const high = rule({ id: 2, priority: 20 })
    expect(selectRule([low, high], ctx({}))?.id).toBe(2)
  })

  it("breaks a priority tie by specificity, then lowest id", () => {
    const broad = rule({ id: 1, priority: 10, conditions: {} })
    const narrow = rule({ id: 2, priority: 10, conditions: { minAmount: 100 } })
    expect(selectRule([broad, narrow], ctx({ amount: 500 }))?.id).toBe(2)

    const a = rule({ id: 5, priority: 10, conditions: { minAmount: 100 } })
    const b = rule({ id: 3, priority: 10, conditions: { maxAmount: 1000 } })
    expect(selectRule([a, b], ctx({ amount: 500 }))?.id).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Chain construction — multi-level, sequential, parallel
// ---------------------------------------------------------------------------

describe("buildChain", () => {
  it("expands each level's approvers into one step apiece, in level order", () => {
    const r = rule({
      levels: [
        { levelNo: 2, mode: "all", approvers: [{ kind: "user", value: "3" }] },
        {
          levelNo: 1,
          mode: "any",
          approvers: [
            { kind: "user", value: "1" },
            { kind: "role", value: "10" },
          ],
        },
      ],
    })
    const chain = buildChain(r)
    expect(chain.map((s) => s.levelNo)).toEqual([1, 1, 2])
    expect(chain[0].target).toEqual({ kind: "user", value: "1" })
    expect(chain[2].levelNo).toBe(2)
  })

  it("clamps quorum to at least 1 and only sets it for quorum mode", () => {
    const r = rule({
      levels: [
        { levelNo: 1, mode: "quorum", quorum: 0, approvers: [{ kind: "user", value: "1" }] },
        { levelNo: 2, mode: "all", quorum: 5, approvers: [{ kind: "user", value: "2" }] },
      ],
    })
    const chain = buildChain(r)
    expect(chain[0].quorum).toBe(1)
    expect(chain[1].quorum).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Level evaluation — all / any / quorum + rejection
// ---------------------------------------------------------------------------

const step = (levelNo: number, mode: RequestStepState["mode"], decision: RequestStepState["decision"], quorum: number | null = null): RequestStepState => ({
  levelNo,
  mode,
  quorum,
  decision,
})

describe("evaluateLevel", () => {
  it("'all' clears only when every step approves", () => {
    expect(evaluateLevel([step(1, "all", "approved"), step(1, "all", "pending")])).toBe("pending")
    expect(evaluateLevel([step(1, "all", "approved"), step(1, "all", "approved")])).toBe("approved")
  })

  it("'any' clears on the first approval", () => {
    expect(evaluateLevel([step(1, "any", "pending"), step(1, "any", "approved")])).toBe("approved")
    expect(evaluateLevel([step(1, "any", "pending"), step(1, "any", "pending")])).toBe("pending")
  })

  it("'quorum' clears once the threshold is met", () => {
    const steps = [
      step(1, "quorum", "approved", 2),
      step(1, "quorum", "pending", 2),
      step(1, "quorum", "pending", 2),
    ]
    expect(evaluateLevel(steps)).toBe("pending")
    steps[1].decision = "approved"
    expect(evaluateLevel(steps)).toBe("approved")
  })

  it("any single rejection fails the level regardless of mode", () => {
    expect(evaluateLevel([step(1, "any", "approved"), step(1, "any", "rejected")])).toBe("rejected")
  })

  it("ignores skipped steps and treats an empty level as approved", () => {
    expect(evaluateLevel([])).toBe("approved")
    expect(evaluateLevel([step(1, "all", "skipped"), step(1, "all", "approved")])).toBe("approved")
  })
})

// ---------------------------------------------------------------------------
// Request progression — sequential multi-level
// ---------------------------------------------------------------------------

describe("evaluateRequest", () => {
  it("stays on the lowest unapproved level (sequential gating)", () => {
    const steps = [step(1, "all", "approved"), step(2, "all", "pending"), step(3, "all", "pending")]
    expect(evaluateRequest(steps)).toEqual({ status: "pending", currentLevel: 2 })
    expect(activeLevelNo(steps)).toBe(2)
  })

  it("approves only when every level is cleared", () => {
    expect(evaluateRequest([step(1, "any", "approved"), step(2, "all", "approved")])).toEqual({
      status: "approved",
      currentLevel: null,
    })
  })

  it("rejects the whole request at the first rejected level", () => {
    const steps = [step(1, "all", "approved"), step(2, "all", "rejected"), step(3, "all", "pending")]
    expect(evaluateRequest(steps)).toEqual({ status: "rejected", currentLevel: 2 })
  })

  it("handles a full parallel-then-sequential chain end to end", () => {
    // Level 1: quorum 2-of-3. Level 2: single approver.
    const steps = [
      step(1, "quorum", "approved", 2),
      step(1, "quorum", "approved", 2),
      step(1, "quorum", "pending", 2),
      step(2, "all", "pending"),
    ]
    // Quorum met at L1 -> now waiting on L2.
    expect(evaluateRequest(steps)).toEqual({ status: "pending", currentLevel: 2 })
    steps[3].decision = "approved"
    expect(evaluateRequest(steps)).toEqual({ status: "approved", currentLevel: null })
  })
})

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

const del = (fromUserId: number, toUserId: number, extra: Partial<Delegation> = {}): Delegation => ({
  fromUserId,
  toUserId,
  active: true,
  ...extra,
})

describe("resolveDelegate", () => {
  it("returns the user unchanged when no delegation applies", () => {
    expect(resolveDelegate(1, [])).toBe(1)
    expect(resolveDelegate(1, [del(2, 3)])).toBe(1)
  })

  it("follows a multi-hop delegation chain to the final delegate", () => {
    expect(resolveDelegate(1, [del(1, 2), del(2, 3)])).toBe(3)
  })

  it("ignores inactive or out-of-window delegations", () => {
    expect(resolveDelegate(1, [del(1, 2, { active: false })])).toBe(1)
    const future = new Date("2999-01-01").toISOString()
    expect(resolveDelegate(1, [del(1, 2, { startsAt: future })])).toBe(1)
    const past = new Date("2000-01-01").toISOString()
    expect(resolveDelegate(1, [del(1, 2, { endsAt: past })])).toBe(1)
  })

  it("respects an active window bounding the current time", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    const d = del(1, 2, { startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-12-31T00:00:00Z" })
    expect(resolveDelegate(1, [d], now)).toBe(2)
  })

  it("does not loop on a cyclic delegation (A->B->A)", () => {
    const result = resolveDelegate(1, [del(1, 2), del(2, 1)])
    expect([1, 2]).toContain(result)
  })
})

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const overdue = (partial: Partial<OverdueStep>): OverdueStep => ({
  levelNo: 1,
  activatedAt: "2026-06-01T00:00:00Z",
  escalateAfterHours: 24,
  escalateTo: { kind: "user", value: "99" },
  decision: "pending",
  ...partial,
})

describe("computeEscalations", () => {
  const now = new Date("2026-06-03T00:00:00Z") // 48h after activation

  it("flags a pending step past its escalation window", () => {
    expect(computeEscalations([overdue({})], now)).toHaveLength(1)
  })

  it("does not escalate before the window elapses", () => {
    const soon = new Date("2026-06-01T12:00:00Z") // 12h in, window 24h
    expect(computeEscalations([overdue({})], soon)).toHaveLength(0)
  })

  it("skips steps that are not pending, have no target, or no window", () => {
    expect(computeEscalations([overdue({ decision: "approved" })], now)).toHaveLength(0)
    expect(computeEscalations([overdue({ escalateTo: null })], now)).toHaveLength(0)
    expect(computeEscalations([overdue({ escalateAfterHours: null })], now)).toHaveLength(0)
    expect(computeEscalations([overdue({ escalateAfterHours: 0 })], now)).toHaveLength(0)
    expect(computeEscalations([overdue({ activatedAt: null })], now)).toHaveLength(0)
  })
})
