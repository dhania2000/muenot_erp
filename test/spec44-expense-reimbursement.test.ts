import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 44 (#202) — Expense claim reimbursement: partial settlement, cross-period
 * payment dates, over-payment rejection, idempotent retries and tenant-scoped
 * reads. Finance cash posting (recordExpensePayment) is mocked; we assert the
 * claim engine calls it with the right amount/date/key and updates status.
 */

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  getCurrentTenant: vi.fn(),
  pay: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ pool: { getConnection: vi.fn() }, query: m.query, tableColumns: m.tableColumns }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: m.getCurrentTenant }))
vi.mock("@/lib/finance-expenses", () => ({ computeExpenseServerFields: vi.fn(), nextExpenseId: vi.fn() }))
vi.mock("@/lib/finance-expense-posting", () => ({ syncExpensePosting: vi.fn() }))
vi.mock("@/lib/finance-calc", () => ({ financialYearFor: () => "2026-2027" }))
vi.mock("@/lib/finance-expense-payments", () => ({ recordExpensePayment: m.pay }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: m.audit }))

import { planReimbursement } from "@/lib/expense-claims-core"
import { transitionClaim } from "@/lib/expense-claims"

const approver = { userId: 200, role: "admin", name: "Approver", email: "a@x.com" } as any

let claim: Record<string, any>
const updates: { sql: string; params: any[] }[] = []

beforeEach(() => {
  vi.clearAllMocks()
  updates.length = 0
  claim = {
    id: 10,
    tenant_id: 7,
    claim_id: "ECL-2026-000010",
    status: "Approved",
    created_by: 100,
    employee_id: "E1",
    reimbursable_total: 1000,
    reimbursed_amount: 0,
    finance_expense_id: "EXP-2026-000001",
    lines: "[]",
    policy_violations: "[]",
  }
  m.getCurrentTenant.mockReturnValue({ tenantId: 7 })
  m.tableColumns.mockResolvedValue(new Set(["id", "reimbursed_amount"]))
  m.pay.mockResolvedValue({ id: 1, payment_id: "EPY-1" })
  m.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/^SELECT \* FROM hr_expense_claims/.test(sql)) {
      // tenant scope enforced in SQL: a foreign tenant id never matches.
      return params[1] === 7 || claim.tenant_id == null ? [{ ...claim }] : []
    }
    if (/SELECT id FROM expenses/.test(sql)) return [{ id: 55 }]
    if (/^UPDATE hr_expense_claims/.test(sql)) {
      updates.push({ sql, params })
      if (/reimbursed_amount = \?/.test(sql)) {
        claim.status = params[0]
        claim.reimbursed_amount = params[1]
      }
      return { affectedRows: 1 }
    }
    return []
  })
})

describe("planReimbursement (pure)", () => {
  it("defaults to the full remaining balance", () => {
    expect(planReimbursement(1000, 400)).toEqual({
      amount: 600,
      reimbursedAfter: 1000,
      remainingAfter: 0,
      status: "Reimbursed",
    })
  })
  it("supports a partial amount", () => {
    expect(planReimbursement(1000, 0, 250).status).toBe("Partially Reimbursed")
  })
  it("rejects over-payment, zero/negative, and already-settled claims", () => {
    expect(() => planReimbursement(1000, 900, 200)).toThrow(/exceeds/)
    expect(() => planReimbursement(1000, 0, 0)).toThrow(/positive/)
    expect(() => planReimbursement(1000, 0, -5)).toThrow(/positive/)
    expect(() => planReimbursement(1000, 1000)).toThrow(/fully reimbursed/)
  })
  it("rounds to cents without drift", () => {
    const p = planReimbursement(100.3, 33.1, 33.1)
    expect(p.reimbursedAfter).toBe(66.2)
    expect(p.remainingAfter).toBe(34.1)
  })
})

describe("transitionClaim reimburse", () => {
  it("records a partial payment in a later period and marks Partially Reimbursed", async () => {
    const next = await transitionClaim("ECL-2026-000010", "reimburse", approver, {
      amount: 400,
      payment_date: "2026-05-02",
      idempotency_key: "k1",
    })
    expect(m.pay).toHaveBeenCalledWith(
      expect.objectContaining({
        expense_pk: 55,
        amount: 400,
        payment_date: "2026-05-02",
        idempotency_key: "claim:10:k1",
      }),
    )
    expect(next.status).toBe("Partially Reimbursed")
    expect(Number(next.reimbursed_amount)).toBe(400)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "expense_claim.reimburse" }))
  })

  it("settles the remainder and marks Reimbursed", async () => {
    claim.status = "Partially Reimbursed"
    claim.reimbursed_amount = 400
    const next = await transitionClaim("ECL-2026-000010", "reimburse", approver, {})
    expect(m.pay).toHaveBeenCalledWith(expect.objectContaining({ amount: 600 }))
    expect(next.status).toBe("Reimbursed")
  })

  it("rejects an over-payment before touching Finance", async () => {
    await expect(transitionClaim("ECL-2026-000010", "reimburse", approver, { amount: 1500 })).rejects.toThrow(/exceeds/)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it("does not double-count an idempotent retry", async () => {
    m.pay.mockResolvedValueOnce({ id: 1, payment_id: "EPY-1", duplicate: true })
    await transitionClaim("ECL-2026-000010", "reimburse", approver, { amount: 400, idempotency_key: "k1" })
    expect(updates.some((u) => /reimbursed_amount = \?/.test(u.sql))).toBe(false)
    expect(claim.reimbursed_amount).toBe(0)
  })

  it("surfaces a closed-period failure from Finance and leaves the claim unchanged", async () => {
    m.pay.mockRejectedValueOnce(new Error("Accounting period 2026-04 is closed."))
    await expect(
      transitionClaim("ECL-2026-000010", "reimburse", approver, { amount: 100, payment_date: "2026-04-30" }),
    ).rejects.toThrow(/closed/)
    expect(claim.status).toBe("Approved")
  })

  it("rejects a malformed payment date", async () => {
    await expect(
      transitionClaim("ECL-2026-000010", "reimburse", approver, { amount: 100, payment_date: "02/05/2026" }),
    ).rejects.toThrow(/YYYY-MM-DD/)
  })

  it("cannot reach a claim belonging to another tenant", async () => {
    m.getCurrentTenant.mockReturnValue({ tenantId: 8 })
    await expect(transitionClaim("ECL-2026-000010", "reimburse", approver, {})).rejects.toThrow(/not found/i)
    expect(m.pay).not.toHaveBeenCalled()
  })
})
