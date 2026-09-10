import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getSettings } from "@/lib/settings/server"
import { ensureFteInvoiceColumns } from "@/lib/finance-ensure"
import { buildFteInvoicePdf, companyFromSettings, type InvoiceBank } from "@/lib/finance-invoice-pdf"
import {
  sendEmail,
  withTrackingPixel,
  isEmailConfigured,
  hydrateDepartmentSMTP,
  resolveBaseUrl,
} from "@/lib/email"

export const runtime = "nodejs"

async function loadBank(): Promise<InvoiceBank> {
  try {
    const rows = (await query(
      `SELECT account_name, bank_name, account_number, ifsc, branch
         FROM finance_accounts
         ORDER BY primary_account DESC, id ASC
         LIMIT 1`,
    )) as any[]
    const b = rows[0]
    if (!b) return null
    return {
      accountName: b.account_name || "",
      bankName: b.bank_name || "",
      accountNumber: b.account_number || "",
      ifsc: b.ifsc || "",
      branch: b.branch || "",
    }
  } catch {
    return null
  }
}

function esc(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureFteInvoiceColumns()
  const { id } = await ctx.params
  const [inv] = (await query(`SELECT * FROM fte_invoices WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const to = (body.to || inv.employee_email || "").trim()
  if (!to) {
    return NextResponse.json(
      { error: "No recipient email. Add the employee's email on the invoice or enter one." },
      { status: 400 },
    )
  }

  // Make department SMTP / Gmail credentials available, then verify config.
  await hydrateDepartmentSMTP("finance")
  if (!isEmailConfigured("finance")) {
    return NextResponse.json(
      { error: "Finance email is not configured. Add the finance SMTP/Gmail settings first." },
      { status: 400 },
    )
  }

  const [settings, bank] = await Promise.all([getSettings(), loadBank()])
  const company = companyFromSettings(settings)
  const pdf = buildFteInvoicePdf(inv, company, bank)

  const invoiceNo = inv.fte_invoice_id || `#${inv.id}`
  const subject = (body.subject || `FTE Invoice ${invoiceNo} from ${company.name}`).trim()
  const message = (body.message || "").trim()

  const defaultMessage =
    `Dear ${esc(inv.employee_name || "Employee")},<br/><br/>` +
    `Please find attached your FTE invoice <strong>${esc(invoiceNo)}</strong>` +
    `${inv.net_payable ? ` for INR ${Number(inv.net_payable).toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : ""}` +
    `${inv.month ? ` (${esc(String(inv.month))})` : ""}.` +
    `<br/><br/>Regards,<br/>${esc(company.name)}`

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.6;">` +
    (message ? esc(message).replace(/\n/g, "<br/>") : defaultMessage) +
    `</div>`

  // Record the send in finance_emails for history/tracking, then send.
  const senderId = (session as any).userId ?? (session as any).user?.id ?? null
  let emailId: number | null = null
  try {
    const result = (await query(
      `INSERT INTO finance_emails (to_email, subject, body, status, created_by) VALUES (?, ?, ?, 'Queued', ?)`,
      [to, subject, html, senderId],
    )) as any
    emailId = result.insertId
  } catch {
    // finance_emails may not exist in some installs — sending still proceeds.
    emailId = null
  }

  const baseUrl = resolveBaseUrl(req)
  const trackedHtml =
    emailId != null
      ? withTrackingPixel(html, baseUrl, String(emailId)).replace(
          `/api/track/${emailId}`,
          `/api/finance/emails/track/${emailId}`,
        )
      : html

  try {
    await sendEmail({
      to,
      subject,
      html: trackedHtml,
      department: "finance",
      attachments: [
        { filename: `${invoiceNo}.pdf`, content: pdf, contentType: "application/pdf" },
      ],
    })
    if (emailId != null) {
      await query(`UPDATE finance_emails SET status='Sent', sent_at=NOW() WHERE id=?`, [emailId]).catch(() => {})
    }
    await query(
      `UPDATE fte_invoices SET invoice_last_sent_at=NOW(), invoice_last_sent_to=? WHERE id=?`,
      [to, inv.id],
    )
  } catch (err) {
    if (emailId != null) {
      await query(`UPDATE finance_emails SET status='Failed' WHERE id=?`, [emailId]).catch(() => {})
    }
    console.log("[v0] FTE invoice email send failed:", (err as any)?.message)
    return NextResponse.json({ error: "Email send failed. Check the finance email settings." }, { status: 500 })
  }

  return NextResponse.json({ ok: true, to })
}
