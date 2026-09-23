import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listInvoices, createInvoice, getBillingSummary, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * Invoices collection. GET lists every invoice for the acting tenant
 * (tenant-scoped data layer, ) plus the billing summary; POST creates a
 * one-time or recurring invoice with discounts, coupons, tax, credit and
 * adjustments through the pure money core.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const [invoices, summary] = await Promise.all([listInvoices(), getBillingSummary()])
    return NextResponse.json({ invoices, summary })
  } catch (err) {
    console.error("[v0] GET /api/billing/invoices failed:", err)
    return NextResponse.json({ error: "Failed to load invoices" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const invoice = await createInvoice(body, session)
    return NextResponse.json({ ok: true, invoice }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/invoices failed:", err)
    return NextResponse.json({ error: "Failed to create invoice" }, { status: 500 })
  }
}
