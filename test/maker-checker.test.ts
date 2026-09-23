import { describe, it, expect } from "vitest"
import {
  violatesSegregation,
  decideOutcome,
  isOpenStatus,
  isEffectiveStatus,
  SEGREGATION_MESSAGE,
  type ApprovalActionKind,
  type ChangeStatus,
} from "@/lib/maker-checker-core"
import {
  MAKER_CHECKER_OPERATIONS,
  listOperations,
  getOperation,
  isKnownOperation,
  defaultGateState,
} from "@/lib/maker-checker-registry"

/**
 * Phase 4. DB-free proof of the two security guarantees the
 * maker-checker framework must never get wrong: segregation of duties
 * (a maker can never check their own request) and bypass prevention (a gated
 * change only takes effect after an `approved` request). Plus registry
 * integrity for the eight governed high-risk operations.
 */

describe("registry — high-risk operations", () => {
  it("covers every operation family", () => {
    const categories = new Set(MAKER_CHECKER_OPERATIONS.map((o) => o.category))
    for (const c of ["vendor", "banking", "payment", "accounting", "tax", "access", "master-data"]) {
      expect(categories.has(c as any)).toBe(true)
    }
  })

  it("names the eight sensitive operations from the spec", () => {
    const keys = listOperations().map((o) => o.key)
    expect(keys).toEqual([
      "finance.vendor.create",
      "finance.vendor.bank_change",
      "hr.employee.bank_change",
      "finance.payment.create",
      "finance.journal.post",
      "finance.tax.config",
      "admin.user.permissions",
      "masterdata.change",
    ])
  })

  it("has unique keys and module keys for every operation", () => {
    const keys = listOperations().map((o) => o.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const op of listOperations()) {
      expect(op.moduleKey.length).toBeGreaterThan(0)
      expect(op.label.length).toBeGreaterThan(0)
      expect(op.description.length).toBeGreaterThan(0)
    }
  })

  it("looks up known operations and rejects unknown ones", () => {
    expect(isKnownOperation("finance.payment.create")).toBe(true)
    expect(isKnownOperation("finance.nope")).toBe(false)
    expect(getOperation("finance.payment.create")?.category).toBe("payment")
    expect(getOperation("finance.nope")).toBeNull()
  })

  it("defaults money and access operations ON", () => {
    const state = defaultGateState()
    expect(state["finance.payment.create"]).toBe(true)
    expect(state["finance.vendor.bank_change"]).toBe(true)
    expect(state["hr.employee.bank_change"]).toBe(true)
    expect(state["admin.user.permissions"]).toBe(true)
    // Every registered operation has an explicit default.
    expect(Object.keys(state).sort()).toEqual(listOperations().map((o) => o.key).sort())
  })
})

describe("segregation of duties — maker can never be checker", () => {
  const maker = 42

  it("blocks the maker from approving their own request", () => {
    expect(violatesSegregation({ actorId: maker, requesterId: maker, action: "approve" })).toBe(true)
  })

  it("blocks the maker from rejecting, delegating or escalating their own request", () => {
    for (const action of ["reject", "delegate", "escalate"] as ApprovalActionKind[]) {
      expect(violatesSegregation({ actorId: maker, requesterId: maker, action })).toBe(true)
    }
  })

  it("allows the maker to cancel (withdraw) their own request", () => {
    expect(violatesSegregation({ actorId: maker, requesterId: maker, action: "cancel" })).toBe(false)
  })

  it("allows a different checker to approve", () => {
    expect(violatesSegregation({ actorId: 7, requesterId: maker, action: "approve" })).toBe(false)
  })

  it("gives no admin escape hatch — self-approval is blocked regardless of who you are", () => {
    // The rule takes no isAdmin flag; identity equality alone decides.
    expect(violatesSegregation({ actorId: maker, requesterId: maker, action: "approve" })).toBe(true)
  })

  it("does nothing when the requester is unknown", () => {
    expect(violatesSegregation({ actorId: maker, requesterId: null, action: "approve" })).toBe(false)
  })

  it("exposes a human-readable reason", () => {
    expect(SEGREGATION_MESSAGE).toMatch(/cannot approve/i)
  })
})

describe("bypass prevention — outcome gate", () => {
  it("applies a pending change only when the request is approved", () => {
    expect(decideOutcome("approved", "pending")).toEqual({ apply: true, nextStatus: "applied" })
  })

  it("never applies on reject or cancel", () => {
    expect(decideOutcome("rejected", "pending")).toEqual({ apply: false, nextStatus: "rejected" })
    expect(decideOutcome("cancelled", "pending")).toEqual({ apply: false, nextStatus: "cancelled" })
  })

  it("never applies while the request is still pending", () => {
    expect(decideOutcome("pending", "pending")).toEqual({ apply: false, nextStatus: null })
  })

  it("is idempotent — a change past its terminal state is never re-applied", () => {
    for (const s of ["applied", "auto_applied", "rejected", "cancelled", "failed"] as ChangeStatus[]) {
      expect(decideOutcome("approved", s)).toEqual({ apply: false, nextStatus: null })
    }
  })

  it("classifies statuses correctly", () => {
    expect(isOpenStatus("pending")).toBe(true)
    expect(isOpenStatus("applied")).toBe(false)
    expect(isEffectiveStatus("applied")).toBe(true)
    expect(isEffectiveStatus("auto_applied")).toBe(true)
    expect(isEffectiveStatus("pending")).toBe(false)
    expect(isEffectiveStatus("rejected")).toBe(false)
  })
})
