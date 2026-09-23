import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getInvoice, listPayments, listRefunds } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * Single invoice with its payments and refunds. The id is resolved
 * through the tenant-scoped data layer, so a client can never read another
 * tenant's invoice (IDOR-safe).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const invoiceId = Number(id)
  try {
    const invoice = await getInvoice(invoiceId)
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
    const [payments, allRefunds] = await Promise.all([listPayments(invoiceId), listRefunds()])
    const refunds = allRefunds.filter((r) => r.invoice_id === invoiceId)
    return NextResponse.json({ invoice, payments, refunds })
  } catch (err) {
    console.error("[v0] GET /api/billing/invoices/[id] failed:", err)
    return NextResponse.json({ error: "Failed to load invoice" }, { status: 500 })
  }
}
