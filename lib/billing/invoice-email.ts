import "server-only"
import { query } from "@/lib/db"
import type { InvoiceView } from "@/lib/billing/billing-engine"
import { buildBillingInvoicePdf, companyForBillingPdf } from "@/lib/billing/invoice-pdf"
import {
  sendEmail,
  withTrackingPixel,
  isEmailConfigured,
  hydrateDepartmentSMTP,
} from "@/lib/email"

/**
 * Billing invoice email delivery (server-only).
 *
 * One code path builds the currency-aware billing PDF, composes the message,
 * records the send in `finance_emails` for history/open-tracking, and dispatches
 * through the finance transport. Handles both regular invoices and credit notes.
 * Mirrors the sales-invoice send path so behaviour and audit stay consistent.
 */

function esc(v: string) {
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  )
}

/** Currency-aware money formatter with a plain-number fallback. */
function moneyFmt(currency: string) {
  let fmt: Intl.NumberFormat | null = null
  try {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" })
  } catch {
    fmt = null
  }
  return (value: number): string => {
    const n = Number(value) || 0
    return fmt ? fmt.format(n) : `${currency || ""} ${n.toFixed(2)}`.trim()
  }
}

/** The default recipient for a billing invoice email, if one is on file. */
export function resolveBillingRecipient(inv: InvoiceView): string | null {
  return inv.bill_to_email?.trim() || null
}

/**
 * Build the invoice/credit-note PDF and email it to `to`. `baseUrl` is used for
 * the open-tracking pixel. Throws on transport failure so callers can surface
 * the error and avoid stamping a false "sent" state.
 */
export async function sendBillingInvoiceEmail(opts: {
  inv: InvoiceView
  to: string
  subject?: string
  message?: string
  baseUrl: string
  actorId?: number | null
}): Promise<{ to: string; emailId: number | null }> {
  const { inv, to, baseUrl } = opts

  await hydrateDepartmentSMTP("finance")
  if (!isEmailConfigured("finance")) {
    throw new Error("Email is not configured. Add the finance SMTP/Gmail settings first.")
  }

  const isCredit = inv.invoice_type === "credit_note"
  const money = moneyFmt(inv.currency)
  const company = await companyForBillingPdf()
  const pdf = buildBillingInvoicePdf(inv, company)

  const docLabel = isCredit ? "Credit note" : "Invoice"
  const customer = inv.bill_to_company || inv.customer_name || "Customer"

  const subject =
    (opts.subject || "").trim() || `${docLabel} ${inv.invoice_no} from ${company.name}`

  const custom = (opts.message || "").trim()
  const defaultBody = isCredit
    ? `Dear ${esc(customer)},<br/><br/>` +
      `Please find attached credit note <strong>${esc(inv.invoice_no)}</strong> ` +
      `for <strong>${money(Math.abs(inv.total))}</strong>.` +
      `<br/><br/>Regards,<br/>${esc(company.name)}`
    : `Dear ${esc(customer)},<br/><br/>` +
      `Please find attached invoice <strong>${esc(inv.invoice_no)}</strong> ` +
      `for <strong>${money(inv.total)}</strong>` +
      `${inv.balance > 0 ? `, with an outstanding balance of <strong>${money(inv.balance)}</strong>` : ""}` +
      `${inv.due_date ? `, due by <strong>${esc(String(inv.due_date))}</strong>` : ""}.` +
      `<br/><br/>Regards,<br/>${esc(company.name)}`

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.6;">` +
    (custom ? esc(custom).replace(/\n/g, "<br/>") : defaultBody) +
    `</div>`

  // Record the send for history/tracking; delivery still proceeds if the table
  // is absent in some installs.
  let emailId: number | null = null
  try {
    const result = (await query(
      `INSERT INTO finance_emails (to_email, subject, body, status, created_by) VALUES (?, ?, ?, 'Queued', ?)`,
      [to, subject, html, opts.actorId ?? null],
    )) as any
    emailId = result.insertId
  } catch {
    emailId = null
  }

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
      attachments: [{ filename: `${inv.invoice_no}.pdf`, content: pdf, contentType: "application/pdf" }],
    })
    if (emailId != null) {
      await query(`UPDATE finance_emails SET status='Sent', sent_at=NOW() WHERE id=?`, [emailId]).catch(() => {})
    }
  } catch (err) {
    if (emailId != null) {
      await query(`UPDATE finance_emails SET status='Failed' WHERE id=?`, [emailId]).catch(() => {})
    }
    throw err
  }

  return { to, emailId }
}
