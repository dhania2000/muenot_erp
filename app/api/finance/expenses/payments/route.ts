import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  listExpensePayments,
  recordExpensePayment,
  reverseExpensePayment,
  type RecordExpensePaymentInput,
} from "@/lib/finance-expense-payments"

/**
 * Expense payment engine endpoint — the transaction-driven cash layer for
 * payables (Payment / Refund / Advance) plus reversals. All money math,
 * outstanding validation, cash-voucher posting, and expense recomputation live
 * in finance-expense-payments; this route authenticates and delegates.
 *
 *   GET  /api/finance/expenses/payments?expense_pk=123   → list (optionally scoped)
 *   POST /api/finance/expenses/payments                  → record a transaction
 *   POST /api/finance/expenses/payments  { action:"reverse", id, reason }
 */

const TYPES = ["Payment", "Refund", "Advance"] as const

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const raw = req.nextUrl.searchParams.get("expense_pk")
  const expensePk = raw != null && raw !== "" ? Number(raw) : undefined
  if (raw != null && raw !== "" && (!Number.isInteger(expensePk) || (expensePk as number) <= 0)) {
    return NextResponse.json({ error: "Invalid expense_pk." }, { status: 400 })
  }

  try {
    const rows = await listExpensePayments(expensePk)
    return NextResponse.json({ rows })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  // --- Reverse an existing payment ------------------------------------------
  if (String(body.action || "") === "reverse") {
    const id = Number(body.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "A valid payment id is required to reverse." }, { status: 400 })
    }
    const reason = String(body.reason || "").trim()
    if (!reason) return NextResponse.json({ error: "A reversal reason is required." }, { status: 400 })
    try {
      const result = await reverseExpensePayment(id, reason, session.userId)
      return NextResponse.json(result ?? { ok: true })
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }
  }

  // --- Record a Payment / Refund / Advance ----------------------------------
  const expensePk = Number(body.expense_pk ?? body.expensePk)
  if (!Number.isInteger(expensePk) || expensePk <= 0) {
    return NextResponse.json({ error: "A valid expense_pk is required." }, { status: 400 })
  }

  const paymentType = (body.payment_type ?? "Payment") as (typeof TYPES)[number]
  if (!TYPES.includes(paymentType)) {
    return NextResponse.json({ error: `payment_type must be one of: ${TYPES.join(", ")}.` }, { status: 400 })
  }

  if (!body.payment_date) {
    return NextResponse.json({ error: "A payment_date is required." }, { status: 400 })
  }

  const input: RecordExpensePaymentInput = {
    expense_pk: expensePk,
    payment_type: paymentType,
    payment_date: String(body.payment_date),
    amount: Number(body.amount),
    payment_mode: body.payment_mode ? String(body.payment_mode) : undefined,
    deposit_role: body.deposit_role === "cash" ? "cash" : body.deposit_role === "bank" ? "bank" : undefined,
    reference_no: body.reference_no != null ? String(body.reference_no) : null,
    narration: body.narration != null ? String(body.narration) : null,
    idempotency_key: body.idempotency_key != null ? String(body.idempotency_key) : null,
    created_by: session.userId,
  }

  try {
    const result = await recordExpensePayment(input)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
