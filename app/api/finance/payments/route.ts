import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  listPayments,
  getPaymentDetail,
  getOutstandingInvoices,
  receivableAgeing,
  customerStatement,
  recordPayment,
  reversePayment,
} from "@/lib/finance-payments"
import { isOperationGated, submitForApproval } from "@/lib/maker-checker"

// Payments are Accounts-Receivable against sales invoices, so they are gated by
// the same feature as Sales Invoices.
const FEATURE = "finance.sales_invoices"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const p = req.nextUrl.searchParams
  const view = p.get("view")

  try {
    if (view === "outstanding") {
      return NextResponse.json({ invoices: await getOutstandingInvoices(p.get("party") || undefined) })
    }
    if (view === "ageing") {
      return NextResponse.json({ ageing: await receivableAgeing(p.get("party") || undefined) })
    }
    if (view === "statement") {
      const party = p.get("party") || ""
      return NextResponse.json({ statement: await customerStatement(party) })
    }
    const id = Number(p.get("id"))
    if (id) {
      const detail = await getPaymentDetail(id)
      if (!detail) return NextResponse.json({ error: "Payment not found" }, { status: 404 })
      return NextResponse.json({ payment: detail })
    }
    const payments = await listPayments({
      status: p.get("status") || undefined,
      party: p.get("party") || undefined,
      from: p.get("from") || undefined,
      to: p.get("to") || undefined,
      search: p.get("search") || undefined,
    })
    return NextResponse.json({ payments })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json().catch(() => ({}))

  // The prepared receipt, captured once so the same shape is either applied now
  // or deferred to a checker. `created_by` records who prepared it (the maker).
  const paymentInput = {
    party_id: body.party_id ?? null,
    party_name: body.party_name ?? null,
    payment_date: body.payment_date,
    payment_mode: body.payment_mode,
    deposit_role: body.deposit_role === "cash" ? ("cash" as const) : ("bank" as const),
    reference_no: body.reference_no ?? null,
    narration: body.narration ?? null,
    financial_year: body.financial_year ?? null,
    allocations: Array.isArray(body.allocations) ? body.allocations : [],
    idempotency_key: body.idempotency_key ?? null,
    created_by: session.userId,
  }

  try {
    // SPEC 12 — maker-checker. When payment creation is gated, the receipt is
    // NOT posted here; it is captured and held until a different person (never
    // the maker — segregation is enforced in the approval engine) approves it.
    if (await isOperationGated("finance.payment.create")) {
      const amount = paymentInput.allocations.reduce((sum: number, a: any) => sum + Number(a?.amount || 0), 0)
      const submission = await submitForApproval({
        operationKey: "finance.payment.create",
        payload: paymentInput,
        maker: { userId: session.userId, name: session.name ?? null, role: session.role ?? null },
        entityType: "payment",
        entityRef: paymentInput.reference_no,
        title: `Payment${paymentInput.party_name ? ` to ${paymentInput.party_name}` : ""}`,
        amount: amount || null,
      })

      if (submission.pending) {
        return NextResponse.json(
          {
            ok: true,
            pending: true,
            requiresApproval: true,
            changeId: submission.changeId,
            requestId: submission.requestId,
            message: "Payment submitted for approval. It will be posted once a checker approves it.",
          },
          { status: 202 },
        )
      }
      // Auto-applied (no approval rule configured) — behaves like a direct post.
      return NextResponse.json({ ok: true, autoApplied: true, payment_id: submission.ref, changeId: submission.changeId })
    }

    const result = await recordPayment(paymentInput)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Payment id is required" }, { status: 400 })
  if (body.action !== "reverse") return NextResponse.json({ error: "Unsupported action" }, { status: 400 })

  try {
    const result = await reversePayment(id, String(body.reason || ""), session.userId)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
