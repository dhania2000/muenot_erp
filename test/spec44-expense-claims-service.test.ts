import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 44 — Expense-claim server engine. Exercises the parts that must never be
 * trusted to the browser: TENANT SCOPE on the list query, OWNERSHIP isolation on
 * a single-claim read (a non-owner employee cannot reach another user's claim),
 * the APPROVER-ONLY gate, SEGREGATION OF DUTIES (no self-approval), and the
 * legal-transition guard. The finance projection is mocked out — these tests
 * assert the guards that run before it.
 */

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  getCurrentTenant: vi.fn(),
  compute: vi.fn(),
  nextExpenseId: vi.fn(),
  sync: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({
  pool: { getConnection: vi.fn() },
  query: m.query,
  tableColumns: m.tableColumns,
}))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: m.getCurrentTenant }))
vi.mock("@/lib/finance-expenses", () => ({
  computeExpenseServerFields: m.compute,
  nextExpenseId: m.nextExpenseId,
}))
vi.mock("@/lib/finance-expense-posting", () => ({ syncExpensePosting: m.sync }))
vi.mock("@/lib/finance-calc", () => ({ financialYearFor: () => "2026-2027" }))
vi.mock("@/lib/finance-expense-payments", () => ({ recordExpensePayment: vi.fn() }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: vi.fn() }))

import { getClaim, listClaims, transitionClaim } from "@/lib/expense-claims"

const owner = { userId: 100, role: "employee", name: "Asha", email: "asha@x.com" } as any
const otherEmployee = { userId: 999, role: "employee", name: "Ben", email: "ben@x.com" } as any
const admin = { userId: 200, role: "admin", name: "Admin", email: "admin@x.com" } as any

// The claim the DB returns. Owned by user 100 / employee E1.
let claim: Record<string, any>
// The hr_employees row resolveSessionEmployee finds for the acting user.
let employee: Record<string, any> | null

function claimRow(over: Record<string, any> = {}) {
  return {
    id: 10,
    tenant_id: 7,
    claim_id: "ECL-2026-000010",
    status: "Draft",
    created_by: 100,
    employee_id: "E1",
    employee_name: "Asha",
    reimbursable_total: 500,
    claim_date: "2026-03-01",
    lines: JSON.stringify([{ category: "meals", description: "Lunch", date: "2026-03-01", amount: 500 }]),
    policy_violations: JSON.stringify([]),
    ...over,
  }
}

beforeEach(() => {
  for (const fn of Object.values(m)) (fn as any).mockReset?.()
  m.getCurrentTenant.mockReturnValue({ tenantId: 7 })
  claim = claimRow()
  employee = { employee_id: "E1", employee_name: "Asha", department: null, designation: null, official_email: null, reporting_manager: null }
  m.query.mockImplementation(async (sql: string) => {
    if (/^\s*CREATE TABLE/i.test(sql)) return undefined
    if (/FROM hr_expense_claims/i.test(sql)) return claim ? [claim] : []
    if (/FROM hr_employees/i.test(sql)) return employee ? [employee] : []
    return undefined
  })
})

describe("listClaims — tenant + ownership scope", () => {
  it("scopes the query to the current tenant for a non-admin and filters to their own claims", async () => {
    await listClaims(owner)
    const call = m.query.mock.calls.find(([sql]) => /SELECT \* FROM hr_expense_claims WHERE/i.test(String(sql)))
    expect(call).toBeTruthy()
    const [sql, params] = call!
    expect(String(sql)).toMatch(/tenant_id = \?/)
    expect(String(sql)).toMatch(/created_by = \? OR employee_id = \?/)
    // tenant 7 from the session context, then the owner's user id + employee id.
    expect(params).toEqual([7, 100, "E1"])
  })

  it("does not add the ownership filter for an admin (whole-tenant view)", async () => {
    await listClaims(admin)
    const call = m.query.mock.calls.find(([sql]) => /SELECT \* FROM hr_expense_claims WHERE/i.test(String(sql)))
    const [sql, params] = call!
    expect(String(sql)).not.toMatch(/created_by = \?/)
    expect(params).toEqual([7])
  })
})

describe("getClaim — ownership isolation", () => {
  it("returns the claim to its owner", async () => {
    const got = await getClaim("ECL-2026-000010", owner)
    expect(got?.claim_id).toBe("ECL-2026-000010")
  })

  it("hides another employee's claim (cross-user isolation)", async () => {
    employee = { employee_id: "E9", official_email: null } // acting user maps to a different employee
    const got = await getClaim("ECL-2026-000010", otherEmployee)
    expect(got).toBeNull()
  })

  it("lets an admin read any claim in the tenant", async () => {
    const got = await getClaim("ECL-2026-000010", admin)
    expect(got?.claim_id).toBe("ECL-2026-000010")
  })
})

describe("transitionClaim — permissions & segregation of duties", () => {
  it("rejects an approval by a non-approver", async () => {
    claim = claimRow({ status: "Submitted" })
    await expect(transitionClaim("ECL-2026-000010", "approve", owner)).rejects.toThrow(/only an approver/i)
  })

  it("blocks an approver from approving a claim they raised (SoD)", async () => {
    claim = claimRow({ status: "Submitted", created_by: 200 }) // raised by the admin
    await expect(transitionClaim("ECL-2026-000010", "approve", admin)).rejects.toThrow(/segregation of duties/i)
    expect(m.sync).not.toHaveBeenCalled()
  })

  it("rejects an illegal transition (approve a Draft)", async () => {
    claim = claimRow({ status: "Draft" })
    await expect(transitionClaim("ECL-2026-000010", "approve", admin)).rejects.toThrow(/cannot approve a claim that is Draft/i)
  })

  it("blocks submission while a blocking policy violation is unresolved", async () => {
    claim = claimRow({
      status: "Draft",
      policy_violations: JSON.stringify([{ line: 1, severity: "error", message: "Receipt required" }]),
    })
    await expect(transitionClaim("ECL-2026-000010", "submit", owner)).rejects.toThrow(/resolve the policy violations/i)
  })

  it("submits a clean Draft, moving it to Submitted", async () => {
    claim = claimRow({ status: "Draft" })
    await transitionClaim("ECL-2026-000010", "submit", owner)
    const update = m.query.mock.calls.find(([sql]) => /UPDATE hr_expense_claims SET status = \?, submitted_at/i.test(String(sql)))
    expect(update).toBeTruthy()
    expect(update![1][0]).toBe("Submitted")
  })

  it("throws Claim not found when the acting user cannot see the claim", async () => {
    employee = { employee_id: "E9", official_email: null }
    await expect(transitionClaim("ECL-2026-000010", "submit", otherEmployee)).rejects.toThrow(/claim not found/i)
  })
})
