import { beforeEach, describe, expect, it, vi } from "vitest"

// Spec37 (#201) — server-side guards for purchase three-way matching.
//
// These exercise resolveMatchException end-to-end against a mocked MySQL: the
// pieces that actually protect payment — tenant scoping, segregation of duties,
// idempotent overrides, optimistic concurrency, and the "no exception to
// resolve" guard. Every DB call is a scripted `query` response, so the test
// asserts the control flow, the arguments sent to MySQL, and the audit write.

const mock = vi.hoisted(() => ({ query: vi.fn(), tenant: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/tenant-context", () => ({ getTenantId: mock.tenant }))

import {
  resolveMatchException,
  carryResolution,
  __resetMatchSchemaForTests,
} from "@/lib/finance-three-way-match-server"

/** Rows for a single open exception match owned by tenant 7. */
function openExceptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tenant_id: 7,
    bill_id: "BILL-1",
    bill_number: "V-100",
    po_number: "PO-1",
    grn_number: "GRN-1",
    vendor_id: 42,
    vendor_name: "Acme",
    match_status: "exception",
    payment_hold: 1,
    resolution_status: "open",
    categories: "quantity_over",
    resolved_categories: null,
    billed_taxable: 1200,
    billed_quantity: 120,
    evidence: JSON.stringify({ status: "exception", categories: ["quantity_over"] }),
    computed_at: "2027-02-02 10:00:00",
    ...overrides,
  }
}

/**
 * Script the sequence of `query` calls resolveMatchException makes for a
 * successful override:
 *   ensureMatchSchema()  → several DDL/known calls (tolerated, return [])
 *   idempotency lookup   → [] (miss) unless overridden
 *   load match row       → [row]
 *   SoD: bill created_by → [] and PO approver → []
 *   UPDATE               → { affectedRows: 1 }
 *   audit insert         → []
 *   re-read fresh row    → [updatedRow]
 *   idempotency store    → []
 */
function scriptSuccess(row: Record<string, unknown>, updated: Record<string, unknown>) {
  const responses: unknown[] = []
  mock.query.mockImplementation((sql: string) => {
    const s = String(sql)
    if (s.includes("finance_match_idempotency") && s.trim().startsWith("SELECT")) return Promise.resolve([])
    if (s.includes("FROM finance_match_results") && s.includes("bill_id = ?") && s.includes("LIMIT 1")) {
      // First read returns the open row; subsequent read returns the updated row.
      return Promise.resolve([responses.length++ === 0 ? row : updated])
    }
    if (s.includes("FROM purchase_bills")) return Promise.resolve([]) // no created_by match
    if (s.includes("procurement_purchase_orders")) return Promise.resolve([]) // no PO approver match
    if (s.trim().startsWith("UPDATE finance_match_results")) return Promise.resolve({ affectedRows: 1 })
    return Promise.resolve([])
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  __resetMatchSchemaForTests()
  mock.tenant.mockResolvedValue(7)
  mock.query.mockResolvedValue([])
})

describe("resolveMatchException — tenant scope", () => {
  it("returns 404 when the bill is not in the caller's tenant", async () => {
    // Every match_results read comes back empty → the record is not visible.
    mock.query.mockImplementation((sql: string) =>
      String(sql).includes("FROM finance_match_results") ? Promise.resolve([]) : Promise.resolve([]),
    )
    const r = await resolveMatchException(9, "BILL-X", "approve", { userId: 1, userName: "Checker", note: "n/a" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(404)
  })

  it("scopes the match lookup by the passed tenant id, never client input", async () => {
    mock.query.mockImplementation((sql: string) =>
      String(sql).includes("FROM finance_match_results") ? Promise.resolve([]) : Promise.resolve([]),
    )
    await resolveMatchException(7, "BILL-1", "approve", { userId: 1, userName: "C", note: "note enough" })
    const lookup = mock.query.mock.calls.find(
      (c) => String(c[0]).includes("FROM finance_match_results") && String(c[0]).includes("bill_id = ?"),
    )
    expect(lookup?.[1]).toEqual([7, "BILL-1"])
  })
})

describe("resolveMatchException — nothing to resolve", () => {
  it("returns 409 when the match is not in exception", async () => {
    mock.query.mockImplementation((sql: string) =>
      String(sql).includes("FROM finance_match_results")
        ? Promise.resolve([openExceptionRow({ match_status: "matched", payment_hold: 0 })])
        : Promise.resolve([]),
    )
    const r = await resolveMatchException(7, "BILL-1", "approve", { userId: 1, userName: "C", note: "note enough" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })
})

describe("resolveMatchException — segregation of duties", () => {
  it("refuses the checker who booked the vendor bill (403)", async () => {
    mock.query.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes("finance_match_idempotency")) return Promise.resolve([])
      if (s.includes("FROM finance_match_results")) return Promise.resolve([openExceptionRow()])
      if (s.includes("FROM purchase_bills")) return Promise.resolve([{ created_by: 55 }])
      return Promise.resolve([])
    })
    const r = await resolveMatchException(7, "BILL-1", "approve", { userId: 55, userName: "Maker", note: "trying to self-approve" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.error).toMatch(/booked the vendor bill/i)
    }
  })

  it("refuses the PO approver (403)", async () => {
    mock.query.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes("finance_match_idempotency")) return Promise.resolve([])
      if (s.includes("FROM finance_match_results")) return Promise.resolve([openExceptionRow()])
      if (s.includes("FROM purchase_bills")) return Promise.resolve([{ created_by: 999 }])
      if (s.includes("procurement_purchase_orders")) return Promise.resolve([{ approved_by_user_id: 55 }])
      return Promise.resolve([])
    })
    const r = await resolveMatchException(7, "BILL-1", "approve", { userId: 55, userName: "Approver", note: "trying to self-approve" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.error).toMatch(/purchase order approver/i)
    }
  })
})

describe("resolveMatchException — happy path + audit", () => {
  it("approves, releases the hold, and writes an audit event", async () => {
    const row = openExceptionRow()
    const updated = openExceptionRow({ resolution_status: "approved", payment_hold: 0, resolved_by: 55, resolved_by_name: "Checker" })
    scriptSuccess(row, updated)

    const r = await resolveMatchException(7, "BILL-1", "approve", {
      userId: 55,
      userName: "Checker",
      note: "Reviewed GRN, minor over-delivery accepted.",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.match.resolutionStatus).toBe("approved")
      expect(r.match.paymentHold).toBe(false)
    }
    // An audit row was inserted into finance_match_events.
    const audit = mock.query.mock.calls.find((c) => String(c[0]).includes("finance_match_events") && String(c[0]).includes("INSERT"))
    expect(audit).toBeTruthy()
  })

  it("rejects and keeps the payment held", async () => {
    const row = openExceptionRow()
    const updated = openExceptionRow({ resolution_status: "rejected", payment_hold: 1 })
    scriptSuccess(row, updated)
    const r = await resolveMatchException(7, "BILL-1", "reject", { userId: 55, userName: "Checker", note: "Overbilled — disputed with vendor." })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.match.resolutionStatus).toBe("rejected")
      expect(r.match.paymentHold).toBe(true)
    }
  })
})

describe("resolveMatchException — optimistic concurrency", () => {
  it("returns 409 when the guarded UPDATE affects no rows (match changed under us)", async () => {
    mock.query.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes("finance_match_idempotency")) return Promise.resolve([])
      if (s.includes("FROM finance_match_results")) return Promise.resolve([openExceptionRow()])
      if (s.includes("FROM purchase_bills")) return Promise.resolve([])
      if (s.includes("procurement_purchase_orders")) return Promise.resolve([])
      if (s.trim().startsWith("UPDATE finance_match_results")) return Promise.resolve({ affectedRows: 0 })
      return Promise.resolve([])
    })
    const r = await resolveMatchException(7, "BILL-1", "approve", { userId: 55, userName: "Checker", note: "note long enough" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })
})

describe("resolveMatchException — idempotency", () => {
  it("replays the stored response for a repeated key and does not UPDATE again", async () => {
    const stored = { billId: "BILL-1", resolutionStatus: "approved", paymentHold: false }
    mock.query.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes("finance_match_idempotency") && s.trim().startsWith("SELECT")) {
        return Promise.resolve([{ bill_id: "BILL-1", decision: "approve", response: JSON.stringify(stored) }])
      }
      return Promise.resolve([])
    })
    const r = await resolveMatchException(7, "BILL-1", "approve", {
      userId: 55,
      userName: "Checker",
      note: "note long enough",
      idempotencyKey: "abc-123",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.replayed).toBe(true)
      expect(r.match.resolutionStatus).toBe("approved")
    }
    expect(mock.query.mock.calls.some((c) => String(c[0]).trim().startsWith("UPDATE finance_match_results"))).toBe(false)
  })

  it("rejects a key reused for a different bill/decision (409)", async () => {
    mock.query.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes("finance_match_idempotency") && s.trim().startsWith("SELECT")) {
        return Promise.resolve([{ bill_id: "BILL-OTHER", decision: "approve", response: "{}" }])
      }
      return Promise.resolve([])
    })
    const r = await resolveMatchException(7, "BILL-1", "approve", {
      userId: 55,
      userName: "Checker",
      note: "note long enough",
      idempotencyKey: "abc-123",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })
})

describe("carryResolution — recompute never releases a stale hold", () => {
  it("keeps an approval only when the exception set is unchanged", () => {
    expect(carryResolution({ resolution_status: "approved", resolved_categories: "quantity_over" }, ["quantity_over"])).toBe("approved")
  })
  it("reopens when a new exception category appears", () => {
    expect(carryResolution({ resolution_status: "approved", resolved_categories: "quantity_over" }, ["quantity_over", "amount_over"])).toBe(
      "open",
    )
  })
  it("reopens when there was no prior decision", () => {
    expect(carryResolution(null, ["quantity_over"])).toBe("open")
  })
  it("clears to open when there are no exceptions", () => {
    expect(carryResolution({ resolution_status: "approved", resolved_categories: "quantity_over" }, [])).toBe("open")
  })
})
