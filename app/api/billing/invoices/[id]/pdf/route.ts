import { NextRequest, NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getInvoice } from "@/lib/billing/billing-engine"
import { buildBillingInvoicePdf, companyForBillingPdf } from "@/lib/billing/invoice-pdf"

export const runtime = "nodejs"

/**
 * Render a billing invoice (or credit note) as a PDF. `?download=1`
 * forces a download; otherwise it renders inline. Tenant-scoped through
 * getInvoice, so one tenant can never fetch another's document.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const invoice = await getInvoice(Number(id))
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const company = await companyForBillingPdf()
  const pdf = buildBillingInvoicePdf(invoice, company)

  const label = invoice.invoice_type === "credit_note" ? "credit-note" : "invoice"
  const filename = `${invoice.invoice_no || label}.pdf`
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
