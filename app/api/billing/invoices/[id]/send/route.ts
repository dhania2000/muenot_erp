import { NextRequest, NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getInvoice, markInvoiceSent } from "@/lib/billing/billing-engine"
import { resolveBaseUrl } from "@/lib/email"
import { resolveBillingRecipient, sendBillingInvoiceEmail } from "@/lib/billing/invoice-email"

export const runtime = "nodejs"

/**
 * Email a billing invoice (or credit note) as a PDF attachment.
 * Draft invoices must be finalized first so a customer never receives a
 * non-final document. Tenant-scoped through getInvoice/markInvoiceSent.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const invoice = await getInvoice(Number(id))
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
  if (invoice.status === "draft") {
    return NextResponse.json({ error: "Finalize the invoice before emailing it." }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}) as any)
  const to = String(body.to || resolveBillingRecipient(invoice) || "").trim()
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json(
      { error: "A valid recipient email is required.", fields: { to: "Enter a valid email address." } },
      { status: 400 },
    )
  }

  try {
    const { emailId } = await sendBillingInvoiceEmail({
      inv: invoice,
      to,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      baseUrl: resolveBaseUrl(req),
      actorId: (session as any).userId ?? null,
    })
    await markInvoiceSent(invoice.id, to)
    return NextResponse.json({ ok: true, to, emailId })
  } catch (err: any) {
    console.error("[v0] POST /api/billing/invoices/[id]/send failed:", err)
    return NextResponse.json({ error: err?.message || "Failed to send invoice email" }, { status: 502 })
  }
}
