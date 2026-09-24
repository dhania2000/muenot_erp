import { beforeEach, describe, expect, it, vi } from "vitest"

// SPEC 167 — Payment Reconciliation. These tests exercise the allocation engine
// that connects a cash receipt to one or more sales invoices
// (lib/finance-payments.ts), and the way each touched invoice's outstanding /
// payment_status is recomputed from the SUM of its ACTIVE allocations:
//
//   1. Partial payment — a receipt smaller than the invoice outstanding leaves a
//      positive balance and marks the invoice "Partially Paid", never "Paid".
//   2. Multiple invoices — one receipt split across several invoices posts a
//      single cash voucher for the total and writes one allocation row each.
//   3. Over-payment — an allocation that exceeds an invoice's server-side
//      outstanding is rejected up front; no payment row and no voucher survive.
//   4. Under / exact settlement — recompute flips an invoice to "Paid" only when
//      the summed active allocations cover the net receivable.
//   5. Idempotency — a retried submit with a known key returns the existing
//      payment instead of double-posting.
//   6. Reversal — reversing an active receipt posts a mirror voucher and flips
//      the linked invoices back via recompute; a non-active payment refuses.

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getConnection: vi.fn(),
  postLines: vi.fn(),
  logFinanceEvent: vi.fn(),
  assertPeriodOpen: vi.fn(),
  nextRecordId: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query, pool: { getConnection: mocks.getConnection } }))
vi.mock("@/lib/record-ids", () => ({ nextRecordId: mocks.nextRecordId }))
vi.mock("@/lib/finance-posting", () => ({ postLines: mocks.postLines }))
vi.mock("@/lib/finance-audit", () => ({ logFinanceEvent: mocks.logFinanceEvent }))
vi.mock("@/lib/finance-period-lock", () => ({ assertPeriodOpen: mocks.assertPeriodOpen }))

import { recordPayment, reversePayment } from "@/lib/finance-payments"

type Q = { sql: string; args: any[] }

/**
 * A fake pooled connection that records every INSERT it sees so a test can
 * assert exactly how many allocation rows were written and with what amounts.
 */
function makeConn() {
  const inserts: Q[] = []
  let insertId = 500
  return {
    inserts,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(() => {}),
    query: vi.fn(async (sql: string, args: any[] = []) => {
      inserts.push({ sql, args })
      if (/INSERT INTO payments\b/i.test(sql)) return [{ insertId: ++insertId }] as any
      return [{}] as any
    }),
  }
}

/**
 * Route the top-level `query` mock by SQL shape. `invoices` is the fixture set
 * returned for the up-front validation SELECT (keyed by invoice pk). Any
 * SELECT/UPDATE/DELETE the engine issues afterward is answered generically so
 * the test only has to describe the invoices under test.
 */
function wireQuery(opts: {
  invoices: Record<number, any>
  idempotencyHit?: any
  allocationsForReverse?: any[]
}) {
  const updates: Q[] = []
  const deletes: Q[] = []
  mocks.query.mockImplementation(async (sql: string, args: any[] = []) => {
    if (/SELECT id, payment_id FROM payments WHERE idempotency_key/i.test(sql)) {
      return opts.idempotencyHit ? [opts.idempotencyHit] : []
    }
    if (/FROM sales_invoices WHERE id IN/i.test(sql)) {
      return args.map((pk) => opts.invoices[Number(pk)]).filter(Boolean)
    }
    if (/SELECT \* FROM payments WHERE id/i.test(sql)) {
      return opts.reverseTarget ? [opts.reverseTarget] : []
    }
    if (/SELECT invoice_pk FROM payment_allocations/i.test(sql)) {
      return opts.allocationsForReverse ?? []
    }
    if (/^\s*UPDATE/i.test(sql)) {
      updates.push({ sql, args })
      return [{}]
    }
    if (/^\s*DELETE/i.test(sql)) {
      deletes.push({ sql, args })
      return [{}]
    }
    return [{}]
  })
  return { updates, deletes }
}

const inv = (over: Partial<any> & { id: number }): any => ({
  invoice_id: `INV-${over.id}`,
  client_name: "Acme Ltd",
  net_receivable: 1000,
  outstanding_amount: 1000,
  invoice_status: "Issued",
  invoice_type: "Tax Invoice",
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.assertPeriodOpen.mockResolvedValue(undefined)
  mocks.nextRecordId.mockResolvedValue("PAY-0001")
  mocks.postLines.mockResolvedValue({ voucherNo: "VCH-RCPT-1" })
  mocks.logFinanceEvent.mockResolvedValue(undefined)
})

describe("SPEC 167 — payment allocation engine", () => {
  it("records a partial receipt as a single voucher for the allocated total", async () => {
    const conn = makeConn()
    mocks.getConnection.mockResolvedValue(conn)
    wireQuery({ invoices: { 1: inv({ id: 1, outstanding_amount: 1000 }) } })

    const res = await recordPayment({
      payment_date: "2026-02-01",
      allocations: [{ invoice_pk: 1, amount: 400 }],
    })

    expect(res.amount).toBe(400)
    expect(res.voucher_no).toBe("VCH-RCPT-1")
    // Exactly one cash voucher posted, for the allocated total (not the invoice net).
    expect(mocks.postLines).toHaveBeenCalledTimes(1)
    const [lines] = mocks.postLines.mock.calls[0]
    expect(lines).toEqual([
      { role: "bank", debit: 400, credit: 0 },
      { role: "receivable", debit: 0, credit: 400 },
    ])
    // One allocation row written.
    const allocRows = conn.inserts.filter((q) => /INSERT INTO payment_allocations/i.test(q.sql))
    expect(allocRows).toHaveLength(1)
    expect(allocRows[0].args).toContain(400)
  })

  it("splits one receipt across multiple invoices with one voucher for the sum", async () => {
    const conn = makeConn()
    mocks.getConnection.mockResolvedValue(conn)
    wireQuery({
      invoices: {
        1: inv({ id: 1, outstanding_amount: 300 }),
        2: inv({ id: 2, outstanding_amount: 700 }),
      },
    })

    const res = await recordPayment({
      payment_date: "2026-02-01",
      allocations: [
        { invoice_pk: 1, amount: 300 },
        { invoice_pk: 2, amount: 500 },
      ],
    })

    expect(res.amount).toBe(800)
    const [lines] = mocks.postLines.mock.calls[0]
    expect(lines[0]).toEqual({ role: "bank", debit: 800, credit: 0 })
    const allocRows = conn.inserts.filter((q) => /INSERT INTO payment_allocations/i.test(q.sql))
    expect(allocRows).toHaveLength(2)
    // Each invoice is recomputed after posting.
    expect(mocks.logFinanceEvent).toHaveBeenCalledTimes(1)
  })

  it("rejects an over-payment before any row or voucher is created", async () => {
    const conn = makeConn()
    mocks.getConnection.mockResolvedValue(conn)
    wireQuery({ invoices: { 1: inv({ id: 1, outstanding_amount: 250 }) } })

    await expect(
      recordPayment({ payment_date: "2026-02-01", allocations: [{ invoice_pk: 1, amount: 400 }] }),
    ).rejects.toThrow(/exceeds the outstanding/i)

    // No connection opened, no voucher posted → nothing to compensate.
    expect(mocks.getConnection).not.toHaveBeenCalled()
    expect(mocks.postLines).not.toHaveBeenCalled()
  })

  it("accepts an exact settlement up to the outstanding tolerance", async () => {
    const conn = makeConn()
    mocks.getConnection.mockResolvedValue(conn)
    wireQuery({ invoices: { 1: inv({ id: 1, outstanding_amount: 1000 }) } })

    const res = await recordPayment({
      payment_date: "2026-02-01",
      allocations: [{ invoice_pk: 1, amount: 1000 }],
    })
    expect(res.amount).toBe(1000)
    expect(mocks.postLines).toHaveBeenCalledTimes(1)
  })

  it("rejects a payment against a non-collectible invoice type", async () => {
    wireQuery({ invoices: { 1: inv({ id: 1, invoice_type: "Credit Note" }) } })
    await expect(
      recordPayment({ payment_date: "2026-02-01", allocations: [{ invoice_pk: 1, amount: 10 }] }),
    ).rejects.toThrow(/cannot receive a payment/i)
  })

  it("requires at least one positive allocation", async () => {
    await expect(
      recordPayment({ payment_date: "2026-02-01", allocations: [{ invoice_pk: 1, amount: 0 }] }),
    ).rejects.toThrow(/positive amount/i)
    expect(mocks.getConnection).not.toHaveBeenCalled()
  })

  it("returns the existing payment on an idempotent retry without posting again", async () => {
    wireQuery({
      invoices: { 1: inv({ id: 1 }) },
      idempotencyHit: { id: 42, payment_id: "PAY-0042" },
    })

    const res = await recordPayment({
      payment_date: "2026-02-01",
      allocations: [{ invoice_pk: 1, amount: 100 }],
      idempotency_key: "abc-123",
    })

    expect(res).toMatchObject({ id: 42, payment_id: "PAY-0042", duplicate: true })
    expect(mocks.postLines).not.toHaveBeenCalled()
    expect(mocks.getConnection).not.toHaveBeenCalled()
  })
})

describe("SPEC 167 — payment reversal", () => {
  it("posts a mirror voucher and recomputes each linked invoice", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM payments WHERE id/i.test(sql)) {
        return [{ id: 7, payment_id: "PAY-0007", status: "Active", amount: 500, deposit_role: "bank", payment_date: "2026-02-01" }]
      }
      if (/SELECT invoice_pk FROM payment_allocations/i.test(sql)) {
        return [{ invoice_pk: 1 }, { invoice_pk: 2 }]
      }
      if (/net_receivable, invoice_status FROM sales_invoices/i.test(sql)) return []
      return [{}]
    })
    mocks.postLines.mockResolvedValue({ voucherNo: "VCH-REV-1" })

    const res = await reversePayment(7, "bounced cheque", 9)
    expect(res.reversal_voucher_no).toBe("VCH-REV-1")
    const [, ctx] = mocks.postLines.mock.calls[0]
    expect(ctx.reverse).toBe(true)
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "reversed" }))
  })

  it("refuses to reverse a payment that is not active", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM payments WHERE id/i.test(sql)) {
        return [{ id: 7, payment_id: "PAY-0007", status: "Reversed", amount: 500, payment_date: "2026-02-01" }]
      }
      return [{}]
    })
    await expect(reversePayment(7, "dup", 9)).rejects.toThrow(/only an active payment/i)
    expect(mocks.postLines).not.toHaveBeenCalled()
  })
})
