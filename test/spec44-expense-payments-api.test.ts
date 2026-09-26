import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * SPEC 44 — Expense payments API. The route authenticates and delegates all
 * money math to finance-expense-payments (mocked here). These tests assert the
 * HTTP boundary: authentication, input validation, PARTIAL-REIMBURSEMENT
 * failure propagation (an over-payment is rejected server-side), reversal
 * validation, and that the acting user is stamped as created_by.
 */

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  list: vi.fn(),
  record: vi.fn(),
  reverse: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getSession: m.getSession }))
vi.mock("@/lib/finance-expense-payments", () => ({
  listExpensePayments: m.list,
  recordExpensePayment: m.record,
  reverseExpensePayment: m.reverse,
}))

import { GET, POST } from "@/app/api/finance/expenses/payments/route"

const url = "http://localhost/api/finance/expenses/payments"
const SESSION = { userId: 5, role: "admin", name: "A", email: "a@x.com" }

function post(body: unknown, raw = false) {
  return POST(
    new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  for (const fn of Object.values(m)) (fn as any).mockReset?.()
  m.getSession.mockResolvedValue(SESSION)
  m.list.mockResolvedValue([])
  m.record.mockResolvedValue({ id: 1, payment_id: "EXPPAY-1", voucher_no: "V1", amount: 100 })
  m.reverse.mockResolvedValue({ id: 1, reversal_voucher_no: "V2" })
})

describe("GET /api/finance/expenses/payments", () => {
  it("401 when unauthenticated", async () => {
    m.getSession.mockResolvedValue(null)
    expect((await GET(new NextRequest(url))).status).toBe(401)
  })

  it("400 for a non-positive/non-integer expense_pk", async () => {
    expect((await GET(new NextRequest(`${url}?expense_pk=0`))).status).toBe(400)
    expect((await GET(new NextRequest(`${url}?expense_pk=abc`))).status).toBe(400)
    expect(m.list).not.toHaveBeenCalled()
  })

  it("lists payments scoped to a valid expense_pk", async () => {
    const res = await GET(new NextRequest(`${url}?expense_pk=42`))
    expect(res.status).toBe(200)
    expect(m.list).toHaveBeenCalledWith(42)
  })
})

describe("POST /api/finance/expenses/payments — validation", () => {
  it("401 when unauthenticated", async () => {
    m.getSession.mockResolvedValue(null)
    expect((await post({ expense_pk: 1, payment_date: "2026-03-01", amount: 10 })).status).toBe(401)
  })

  it("400 on malformed JSON", async () => {
    expect((await post("{not-json", true)).status).toBe(400)
  })

  it("400 for an invalid expense_pk", async () => {
    expect((await post({ expense_pk: -1, payment_date: "2026-03-01", amount: 10 })).status).toBe(400)
  })

  it("400 for an unknown payment_type", async () => {
    const res = await post({ expense_pk: 1, payment_type: "Bribe", payment_date: "2026-03-01", amount: 10 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/payment_type must be one of/i)
  })

  it("400 when payment_date is missing", async () => {
    expect((await post({ expense_pk: 1, amount: 10 })).status).toBe(400)
  })
})

describe("POST /api/finance/expenses/payments — record", () => {
  it("records a partial reimbursement and stamps the acting user as created_by", async () => {
    const res = await post({
      expense_pk: 42,
      payment_type: "Payment",
      payment_date: "2026-03-01",
      amount: 250,
      idempotency_key: "idem-123",
    })
    expect(res.status).toBe(200)
    expect(m.record).toHaveBeenCalledTimes(1)
    const input = m.record.mock.calls[0][0]
    expect(input).toMatchObject({ expense_pk: 42, payment_type: "Payment", amount: 250, idempotency_key: "idem-123", created_by: 5 })
  })

  it("propagates an over-payment rejection from the engine as 400", async () => {
    m.record.mockRejectedValue(new Error("Payment 999 exceeds the outstanding 250 on expense EXP-1."))
    const res = await post({ expense_pk: 42, payment_date: "2026-03-01", amount: 999 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/exceeds the outstanding/i)
  })
})

describe("POST /api/finance/expenses/payments — reverse", () => {
  it("400 without a payment id", async () => {
    expect((await post({ action: "reverse", reason: "wrong account" })).status).toBe(400)
  })

  it("400 without a reason", async () => {
    expect((await post({ action: "reverse", id: 3 })).status).toBe(400)
  })

  it("reverses a payment, passing the acting user", async () => {
    const res = await post({ action: "reverse", id: 3, reason: "duplicate entry" })
    expect(res.status).toBe(200)
    expect(m.reverse).toHaveBeenCalledWith(3, "duplicate entry", 5)
  })
})
