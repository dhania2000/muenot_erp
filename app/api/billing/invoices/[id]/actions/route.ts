import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import {
  finalizeInvoice,
  voidInvoice,
  recordPayment,
  refundInvoice,
  issueCreditNote,
  BillingError,
} from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * Money actions on a single invoice:
 *   finalize — move a draft to open so it can be paid
 *   void     — cancel an unpaid invoice
 *   pay      — record a (full or partial) payment
 *   refund   — refund captured payment, optionally as account credit
 * The invoice id is tenant-scoped, so an action can never touch another
 * tenant's invoice.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const invoiceId = Number(id)

  try {
    const body = await request.json().catch(() => ({}))
    const action = String(body.action || "").toLowerCase()

    switch (action) {
      case "finalize":
        return NextResponse.json({ ok: true, invoice: await finalizeInvoice(invoiceId) })
      case "void":
        return NextResponse.json({ ok: true, invoice: await voidInvoice(invoiceId) })
      case "pay": {
        const payment = await recordPayment(invoiceId, body, session)
        return NextResponse.json({ ok: true, payment })
      }
      case "refund": {
        const refund = await refundInvoice(invoiceId, body, session)
        return NextResponse.json({ ok: true, refund })
      }
      case "credit_note": {
        const creditNote = await issueCreditNote(invoiceId, body, session)
        return NextResponse.json({ ok: true, invoice: creditNote })
      }
      default:
        return NextResponse.json(
          { error: "Unknown action. Use one of: finalize, void, pay, refund, credit_note." },
          { status: 400 },
        )
    }
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/invoices/[id]/actions failed:", err)
    return NextResponse.json({ error: "Action failed" }, { status: 500 })
  }
}
