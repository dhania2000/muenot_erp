import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listRefunds, refundInvoice, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * SPEC 20 — Refunds. GET lists every refund enriched with its invoice/customer.
 * POST issues a refund against a specific invoice (body: invoice_id, amount,
 * reason, as_credit) reusing the same validated engine path as the invoice
 * refund action.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    return NextResponse.json({ refunds: await listRefunds() })
  } catch (err) {
    console.error("[v0] GET /api/billing/refunds failed:", err)
    return NextResponse.json({ error: "Failed to load refunds" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const invoiceId = Number(body.invoice_id)
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      return NextResponse.json({ error: "A valid invoice is required.", fields: { invoice_id: "Select an invoice." } }, { status: 400 })
    }
    const refund = await refundInvoice(invoiceId, body, session)
    return NextResponse.json({ ok: true, refund }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/refunds failed:", err)
    return NextResponse.json({ error: "Failed to issue refund" }, { status: 500 })
  }
}
