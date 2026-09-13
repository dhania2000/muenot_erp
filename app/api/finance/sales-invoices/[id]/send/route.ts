import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureSalesInvoiceSchema } from "@/lib/sales-invoice-db"
import { logFinanceEvent } from "@/lib/finance-audit"
import { resolveBaseUrl } from "@/lib/email"
import { resolveInvoiceRecipient, sendSalesInvoiceEmail } from "@/lib/sales-invoice-email"

export const runtime = "nodejs"

/** Email the invoice PDF to the customer. Advances Issued → Sent on success. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSalesInvoiceSchema()

  const { id } = await ctx.params
  const [inv] = (await query(`SELECT * FROM sales_invoices WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  if (String(inv.invoice_status || "Draft") === "Draft") {
    return NextResponse.json({ error: "Issue the invoice before emailing it." }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))
  const to = (body.to || (await resolveInvoiceRecipient(inv)) || "").trim()
  if (!to) {
    return NextResponse.json(
      { error: "No recipient email. Add the client's email or enter one." },
      { status: 400 },
    )
  }

  try {
    const { emailId } = await sendSalesInvoiceEmail({
      inv,
      to,
      kind: "invoice",
      subject: body.subject,
      message: body.message,
      baseUrl: resolveBaseUrl(req),
      actorId: session.userId,
    })

    // Stamp delivery and advance Issued → Sent (Posted stays Posted).
    const nextStatus = String(inv.invoice_status) === "Issued" ? "Sent" : inv.invoice_status
    await query(
      `UPDATE sales_invoices
          SET invoice_last_sent_at = NOW(), invoice_last_sent_to = ?, invoice_status = ?
        WHERE id = ?`,
      [to, nextStatus, inv.id],
    )
    await logFinanceEvent({
      entityType: "sales_invoice",
      entityPk: Number(inv.id),
      entityRef: String(inv.invoice_id || inv.id),
      type: "sent",
      summary: `Invoice ${inv.invoice_id || inv.id} emailed to ${to}`,
      actorId: session.userId,
      detail: { email_id: emailId, status: nextStatus },
    })
    return NextResponse.json({ ok: true, to, status: nextStatus })
  } catch (err) {
    console.log("[v0] sales invoice email send failed:", (err as any)?.message)
    return NextResponse.json({ error: (err as Error).message || "Email send failed." }, { status: 500 })
  }
}
