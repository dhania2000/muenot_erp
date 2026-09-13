import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { ensureSalesInvoiceSchema } from "@/lib/sales-invoice-db"
import { logFinanceEvent } from "@/lib/finance-audit"
import { resolveBaseUrl } from "@/lib/email"
import { resolveInvoiceRecipient, sendSalesInvoiceEmail } from "@/lib/sales-invoice-email"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Don't chase the same invoice more than once every few days, and stop after a
// handful of attempts so the cron can't turn into a spam loop.
const MIN_DAYS_BETWEEN_REMINDERS = 3
const MAX_REMINDERS = 4
const BATCH = 25

/**
 * Daily sweep: email a payment reminder for every overdue invoice that still
 * has an outstanding balance, a resolvable recipient, and hasn't been reminded
 * too recently or too often. Idempotent and safe to run on any interval.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron sends a bearer token when CRON_SECRET is set; enforce it if present.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureSalesInvoiceSchema()

  const due = (await query(
    `SELECT * FROM sales_invoices
       WHERE invoice_status IN ('Issued','Sent','Posted')
         AND payment_status <> 'Paid'
         AND COALESCE(outstanding_amount, net_receivable, 0) > 0.01
         AND due_date IS NOT NULL
         AND due_date < CURDATE()
         AND COALESCE(reminder_count, 0) < ?
         AND (last_reminder_at IS NULL OR last_reminder_at < (NOW() - INTERVAL ? DAY))
       ORDER BY due_date ASC
       LIMIT ?`,
    [MAX_REMINDERS, MIN_DAYS_BETWEEN_REMINDERS, BATCH],
  )) as any[]

  const baseUrl = resolveBaseUrl(req)
  let sent = 0
  let skipped = 0
  let failed = 0

  for (const inv of due) {
    const to = await resolveInvoiceRecipient(inv)
    if (!to) {
      skipped++
      continue
    }
    try {
      await sendSalesInvoiceEmail({ inv, to, kind: "reminder", baseUrl, actorId: null })
      await query(
        `UPDATE sales_invoices
            SET last_reminder_at = NOW(), reminder_count = reminder_count + 1, invoice_last_sent_to = ?
          WHERE id = ?`,
        [to, inv.id],
      )
      await logFinanceEvent({
        entityType: "sales_invoice",
        entityPk: Number(inv.id),
        entityRef: String(inv.invoice_id || inv.id),
        type: "sent",
        summary: `Automatic payment reminder for ${inv.invoice_id || inv.id} sent to ${to}`,
        amount: Number(inv.outstanding_amount) || null,
        detail: { automated: true },
      })
      sent++
    } catch (err) {
      console.log("[v0] payment reminder cron failed for invoice", inv.id, (err as any)?.message)
      failed++
    }
  }

  return NextResponse.json({ ok: true, considered: due.length, sent, skipped, failed })
}
