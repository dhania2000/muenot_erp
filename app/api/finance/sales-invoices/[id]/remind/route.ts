import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureSalesInvoiceSchema } from "@/lib/sales-invoice-db"
import { logFinanceEvent } from "@/lib/finance-audit"
import { resolveBaseUrl } from "@/lib/email"
import { resolveInvoiceRecipient, sendSalesInvoiceEmail } from "@/lib/sales-invoice-email"

export const runtime = "nodejs"

/** Send a payment reminder for an outstanding invoice. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSalesInvoiceSchema()

  const { id } = await ctx.params
  const [inv] = (await query(`SELECT * FROM sales_invoices WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  if (String(inv.invoice_status || "Draft") === "Draft") {
    return NextResponse.json({ error: "Draft invoices cannot be reminded on." }, { status: 409 })
  }
  if (String(inv.payment_status) === "Paid" || Number(inv.outstanding_amount ?? 0) <= 0.01) {
    return NextResponse.json({ error: "This invoice is already paid; no reminder needed." }, { status: 409 })
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
      kind: "reminder",
      subject: body.subject,
      message: body.message,
      baseUrl: resolveBaseUrl(req),
      actorId: session.userId,
    })

    await query(
      `UPDATE sales_invoices
          SET last_reminder_at = NOW(), reminder_count = reminder_count + 1,
              invoice_last_sent_to = ?
        WHERE id = ?`,
      [to, inv.id],
    )
    await logFinanceEvent({
      entityType: "sales_invoice",
      entityPk: Number(inv.id),
      entityRef: String(inv.invoice_id || inv.id),
      type: "sent",
      summary: `Payment reminder for ${inv.invoice_id || inv.id} sent to ${to}`,
      amount: Number(inv.outstanding_amount) || null,
      actorId: session.userId,
      detail: { email_id: emailId },
    })
    return NextResponse.json({ ok: true, to })
  } catch (err) {
    console.log("[v0] payment reminder send failed:", (err as any)?.message)
    return NextResponse.json({ error: (err as Error).message || "Reminder send failed." }, { status: 500 })
  }
}
