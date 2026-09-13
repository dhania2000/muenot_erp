import { query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import {
  buildSalesInvoicePdf,
  companyFromSettings,
  type InvoiceBank,
  type PartyLike,
} from "@/lib/finance-invoice-pdf"
import {
  sendEmail,
  withTrackingPixel,
  isEmailConfigured,
  hydrateDepartmentSMTP,
} from "@/lib/email"

/**
 * Shared sales-invoice email delivery (server-only) — Phase 3.
 *
 * One code path builds the invoice PDF, resolves the buyer, records the send in
 * `finance_emails` for history/tracking, and dispatches through the finance
 * transport. Both the manual "email invoice" / "payment reminder" routes and
 * the unattended reminder cron call this so behaviour and audit trail stay
 * identical no matter who triggered it. Mirrors the FTE invoice send route.
 */

function esc(v: string) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

const inr = (n: any) =>
  `INR ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Load the primary (or first) bank account to print on the invoice. */
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

/** Resolve the buyer address/GST block plus a contact email from the clients table. */
async function loadBuyer(inv: Record<string, any>): Promise<{ party: PartyLike; email: string | null }> {
  try {
    const rows = (await query(
      `SELECT client_name, company_name, tax_name, gst_number, email,
              address, city, state, country, postal_code
         FROM clients
         WHERE client_code = ? OR client_name = ?
         LIMIT 1`,
      [inv.client_id || "", inv.client_name || ""],
    )) as any[]
    const c = rows[0]
    if (!c) return { party: { name: inv.client_name }, email: null }
    return {
      party: {
        name: c.company_name || c.client_name || inv.client_name,
        gstNumber: c.gst_number,
        taxLabel: c.tax_name || "GSTIN",
        addressLines: [
          c.address,
          [c.city, c.state, c.postal_code].filter(Boolean).join(", "),
          c.country,
        ],
      },
      email: c.email ? String(c.email).trim() : null,
    }
  } catch {
    return { party: { name: inv.client_name }, email: null }
  }
}

/** The default recipient for an invoice email, if one can be resolved. */
export async function resolveInvoiceRecipient(inv: Record<string, any>): Promise<string | null> {
  const { email } = await loadBuyer(inv)
  return email
}

type SendKind = "invoice" | "reminder"

/**
 * Build the invoice PDF and send it (or a payment reminder) to `to`.
 * `baseUrl` is used for the open-tracking pixel. Throws on transport failure so
 * callers can surface the error / retry.
 */
export async function sendSalesInvoiceEmail(opts: {
  inv: Record<string, any>
  to: string
  kind: SendKind
  subject?: string
  message?: string
  baseUrl: string
  actorId?: number | null
}): Promise<{ to: string; emailId: number | null }> {
  const { inv, to, kind, baseUrl } = opts

  await hydrateDepartmentSMTP("finance")
  if (!isEmailConfigured("finance")) {
    throw new Error("Finance email is not configured. Add the finance SMTP/Gmail settings first.")
  }

  const [settings, bank, buyer] = await Promise.all([getSettings(), loadBank(), loadBuyer(inv)])
  const company = companyFromSettings(settings)
  const pdf = buildSalesInvoicePdf(inv, company, buyer.party, bank)

  const invoiceNo = inv.invoice_id || `#${inv.id}`
  const clientName = inv.client_name || buyer.party.name || "Customer"
  const outstanding = Number(inv.outstanding_amount ?? inv.net_receivable ?? 0)

  const subject =
    (opts.subject || "").trim() ||
    (kind === "reminder"
      ? `Payment reminder: Invoice ${invoiceNo} from ${company.name}`
      : `Invoice ${invoiceNo} from ${company.name}`)

  const custom = (opts.message || "").trim()

  const defaultBody =
    kind === "reminder"
      ? `Dear ${esc(clientName)},<br/><br/>` +
        `This is a gentle reminder that invoice <strong>${esc(invoiceNo)}</strong>` +
        `${outstanding > 0 ? ` has an outstanding balance of <strong>${inr(outstanding)}</strong>` : ""}` +
        `${inv.due_date ? ` and was due on <strong>${esc(String(inv.due_date))}</strong>` : ""}.` +
        `<br/><br/>A copy of the invoice is attached for your reference. If payment has already been made, ` +
        `please disregard this message.<br/><br/>Regards,<br/>${esc(company.name)}`
      : `Dear ${esc(clientName)},<br/><br/>` +
        `Please find attached invoice <strong>${esc(invoiceNo)}</strong>` +
        `${Number(inv.invoice_total) ? ` for ${inr(inv.invoice_total)}` : ""}` +
        `${inv.due_date ? `, due by <strong>${esc(String(inv.due_date))}</strong>` : ""}.` +
        `<br/><br/>Regards,<br/>${esc(company.name)}`

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.6;">` +
    (custom ? esc(custom).replace(/\n/g, "<br/>") : defaultBody) +
    `</div>`

  // Record the send for history/tracking; sending still proceeds if the table
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
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf, contentType: "application/pdf" }],
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
