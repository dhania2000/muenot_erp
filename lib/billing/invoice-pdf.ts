import "server-only"
import { jsPDF } from "jspdf"
import type { InvoiceView, InvoiceLine } from "./billing-engine"

// ---------------------------------------------------------------------------
// SaaS billing invoice PDF.
//
// Unlike the finance/freelance PDF (INR + GST specific, single line item), this
// builder is currency-aware and renders the full billing breakdown: structured
// customer billing details, an arbitrary number of line items, discounts,
// coupon, tax, applied account credit, adjustments, and payment status. It also
// renders credit notes (negative-value reversal invoices) correctly.
// ---------------------------------------------------------------------------

export type PdfCompany = {
  name: string
  addressLines: string[]
  email: string
  phone: string
  website: string
  taxLabel: string
  taxNumber: string
}

export const DEFAULT_PDF_COMPANY: PdfCompany = {
  name: "Muenot ERP",
  addressLines: [],
  email: "",
  phone: "",
  website: "",
  taxLabel: "Tax ID",
  taxNumber: "",
}

/** Seller/company block for the PDF header, sourced from env with safe defaults. */
export function companyForBillingPdf(): PdfCompany {
  return {
    ...DEFAULT_PDF_COMPANY,
    name: process.env.COMPANY_NAME || DEFAULT_PDF_COMPANY.name,
    email: process.env.COMPANY_EMAIL || "",
    website: process.env.COMPANY_WEBSITE || "",
    taxNumber: process.env.COMPANY_TAX_NUMBER || "",
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function fmtDate(v: any): string {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Currency-aware money formatter. Falls back to a plain grouped number if the
 *  currency code is not recognized by Intl. */
function moneyFmt(currency: string) {
  let fmt: Intl.NumberFormat | null = null
  try {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" })
  } catch {
    fmt = null
  }
  return (value: number): string => {
    const n = Number(value) || 0
    if (fmt) return fmt.format(n)
    return `${currency || ""} ${n.toFixed(2)}`.trim()
  }
}

// Colours (RGB tuples)
const INK: [number, number, number] = [17, 24, 39]
const MUTED: [number, number, number] = [107, 114, 128]
const HEAD: [number, number, number] = [15, 23, 42]
const LINE: [number, number, number] = [226, 232, 240]
const ZEBRA: [number, number, number] = [244, 246, 250]
const CREDIT: [number, number, number] = [153, 27, 27] // red-800 for credit notes

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  paid: "Paid",
  partial: "Partially Paid",
  void: "Void",
  uncollectible: "Uncollectible",
  refunded: "Refunded",
}

export function buildBillingInvoicePdf(inv: InvoiceView, company: PdfCompany = DEFAULT_PDF_COMPANY): Buffer {
  const isCredit = inv.invoice_type === "credit_note"
  const money = moneyFmt(inv.currency)
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 40
  const right = W - M

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2])
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])
  const accent = isCredit ? CREDIT : HEAD

  let y = 54

  // --- Header: company (left) + title/meta (right) ---
  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(company.name || "Company", M, y)

  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  setColor(MUTED)
  let cy = y + 15
  for (const line of company.addressLines.filter(Boolean)) {
    doc.text(line, M, cy)
    cy += 11
  }
  const contactBits = [
    company.email && `Email: ${company.email}`,
    company.phone && `Phone: ${company.phone}`,
    company.website || "",
  ].filter(Boolean) as string[]
  for (const line of contactBits) {
    doc.text(line, M, cy)
    cy += 11
  }
  if (company.taxNumber) {
    doc.text(`${company.taxLabel || "Tax ID"}: ${company.taxNumber}`, M, cy)
    cy += 11
  }

  // Title block on the right.
  setColor(accent)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text(isCredit ? "CREDIT NOTE" : "INVOICE", right, y, { align: "right" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const meta: Array<[string, string]> = [
    [isCredit ? "Credit Note No" : "Invoice No", String(inv.invoice_no)],
    ["Issue Date", fmtDate(inv.issue_date)],
  ]
  if (inv.due_date) meta.push(["Due Date", fmtDate(inv.due_date)])
  if (inv.period_start && inv.period_end) {
    meta.push(["Billing Period", `${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}`])
  }
  meta.push(["Currency", inv.currency])
  meta.push(["Status", STATUS_LABEL[inv.status] ?? inv.status])
  let my = y + 16
  for (const [label, val] of meta) {
    doc.text(`${label}:`, right - 170, my, { align: "left" })
    setColor(INK)
    doc.text(val, right, my, { align: "right" })
    setColor(MUTED)
    my += 13
  }

  y = Math.max(cy, my) + 8

  // --- Divider ---
  setDraw(accent)
  doc.setLineWidth(1.2)
  doc.line(M, y, right, y)
  y += 20

  // --- Bill To ---
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  setColor(MUTED)
  doc.text("BILLED TO", M, y)
  y += 15

  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  setColor(INK)
  doc.text(inv.bill_to_company || inv.customer_name || "—", M, y)
  y += 14

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const billLines = [
    inv.bill_to_company && inv.customer_name && inv.bill_to_company !== inv.customer_name
      ? `Attn: ${inv.customer_name}`
      : "",
    inv.bill_to_email && `Email: ${inv.bill_to_email}`,
    inv.bill_to_address || "",
    [inv.bill_to_city, inv.bill_to_state, inv.bill_to_postal].filter(Boolean).join(", "),
    inv.bill_to_country || "",
    inv.bill_to_tax_id && `${company.taxLabel || "Tax ID"}: ${inv.bill_to_tax_id}`,
  ].filter(Boolean) as string[]
  for (const line of billLines) {
    doc.text(line, M, y)
    y += 12
  }
  if (isCredit && inv.credit_note_of) {
    setColor(CREDIT)
    doc.setFont("helvetica", "italic")
    doc.text("This credit note reverses a prior invoice.", M, y)
    doc.setFont("helvetica", "normal")
    y += 12
  }
  y += 8

  // --- Line items table ---
  const cols = {
    sno: M + 4,
    desc: M + 28,
    qty: right - 240,
    rate: right - 150,
    amount: right - 4,
  }
  const headerH = 22
  setFill(accent)
  doc.rect(M, y, right - M, headerH, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.setTextColor(255, 255, 255)
  const th = y + 14
  doc.text("#", cols.sno, th)
  doc.text("DESCRIPTION", cols.desc, th)
  doc.text("QTY", cols.qty, th, { align: "right" })
  doc.text("UNIT", cols.rate, th, { align: "right" })
  doc.text("AMOUNT", cols.amount, th, { align: "right" })
  y += headerH

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  inv.lines.forEach((l: InvoiceLine, i: number) => {
    const descLines = doc.splitTextToSize(l.description || "—", cols.qty - cols.desc - 12) as string[]
    const rowH = Math.max(22, descLines.length * 11 + 11)
    // Page break guard.
    if (y + rowH > H - 120) {
      doc.addPage()
      y = 54
    }
    if (i % 2 === 1) {
      setFill(ZEBRA)
      doc.rect(M, y, right - M, rowH, "F")
    }
    setColor(INK)
    const rt = y + 14
    doc.text(String(i + 1), cols.sno, rt)
    doc.text(descLines, cols.desc, rt)
    doc.text(String(l.quantity), cols.qty, rt, { align: "right" })
    doc.text(money(l.unit_amount), cols.rate, rt, { align: "right" })
    doc.text(money(l.amount), cols.amount, rt, { align: "right" })
    y += rowH
  })

  setDraw(LINE)
  doc.setLineWidth(0.7)
  doc.line(M, y, right, y)
  y += 18

  // --- Totals (right aligned block) ---
  const totalsX = right - 240
  const totalRows: Array<[string, string]> = [["Subtotal", money(inv.subtotal)]]
  if (inv.discount_total > 0) {
    const label = inv.coupon_code ? `Discount (${inv.coupon_code})` : "Discount"
    totalRows.push([label, `- ${money(inv.discount_total)}`])
  }
  if (inv.tax_total > 0 || inv.tax_rate > 0) {
    totalRows.push([`Tax (${inv.tax_rate}%)`, money(inv.tax_total)])
  }
  if (inv.adjustment_total) totalRows.push(["Adjustment", money(inv.adjustment_total)])
  if (inv.credit_applied > 0) totalRows.push(["Account Credit Applied", `- ${money(inv.credit_applied)}`])

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9.5)
  for (const [label, val] of totalRows) {
    setColor(MUTED)
    doc.text(label, totalsX, y)
    setColor(INK)
    doc.text(val, right, y, { align: "right" })
    y += 16
  }

  y += 4
  setFill(accent)
  doc.rect(totalsX - 12, y - 12, right - (totalsX - 12), 26, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(255, 255, 255)
  doc.text(isCredit ? "CREDIT TOTAL" : "TOTAL", totalsX, y + 5)
  doc.text(money(inv.total), right, y + 5, { align: "right" })
  y += 34

  // Payment summary (skip for credit notes).
  if (!isCredit) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    const payRows: Array<[string, string]> = []
    if (inv.amount_paid > 0) payRows.push(["Amount Paid", money(inv.amount_paid)])
    if (inv.amount_refunded > 0) payRows.push(["Amount Refunded", money(inv.amount_refunded)])
    payRows.push(["Balance Due", money(inv.balance)])
    for (const [label, val] of payRows) {
      setColor(MUTED)
      doc.text(label, totalsX, y)
      setColor(label === "Balance Due" ? INK : MUTED)
      doc.text(val, right, y, { align: "right" })
      y += 15
    }
    y += 8
  }

  // --- Memo ---
  if (inv.memo) {
    if (y > H - 90) {
      doc.addPage()
      y = 54
    }
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    setColor(MUTED)
    doc.text("NOTES", M, y)
    y += 13
    doc.setFont("helvetica", "normal")
    setColor(INK)
    const noteLines = doc.splitTextToSize(String(inv.memo), right - M) as string[]
    doc.text(noteLines, M, y)
    y += noteLines.length * 12 + 8
  }

  // --- Footer note ---
  const footerY = H - 36
  setDraw(LINE)
  doc.setLineWidth(0.7)
  doc.line(M, footerY - 12, right, footerY - 12)
  setColor(MUTED)
  doc.setFont("helvetica", "italic")
  doc.setFontSize(8)
  doc.text("This is a system-generated document. No signature is required.", M, footerY)
  doc.setFont("helvetica", "normal")
  doc.text(company.name || "", right, footerY, { align: "right" })

  return Buffer.from(doc.output("arraybuffer"))
}
