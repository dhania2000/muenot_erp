import "server-only"
import { jsPDF } from "jspdf"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type InvoiceCompany = {
  name: string
  addressLines: string[]
  email: string
  phone: string
  website: string
  taxLabel: string // e.g. "GSTIN"
  taxNumber: string
}

export type InvoiceBank = {
  accountName: string
  bankName: string
  accountNumber: string
  ifsc: string
  branch: string
} | null

export type FreelanceInvoiceRow = Record<string, any>

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function fmtDate(v: any): string {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Indian digit grouping with two decimals, e.g. 100008 -> "1,00,008.00". */
function grouped(value: number): string {
  const neg = value < 0
  const [intPart, dec] = Math.abs(value).toFixed(2).split(".")
  let last3 = intPart.slice(-3)
  let rest = intPart.slice(0, -3)
  if (rest) {
    last3 = "," + last3
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")
  }
  return `${neg ? "-" : ""}${rest}${last3}.${dec}`
}

function money(value: any): string {
  return `INR ${grouped(Number(value) || 0)}`
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10)
  const o = n % 10
  return `${TENS[t]}${o ? " " + ONES[o] : ""}`
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h) parts.push(`${ONES[h]} Hundred`)
  if (rest) parts.push(twoDigits(rest))
  return parts.join(" ")
}

/** Amount in words, Indian system (Crore / Lakh / Thousand). */
function amountInWords(value: number): string {
  const rupees = Math.floor(Math.abs(value))
  const paise = Math.round((Math.abs(value) - rupees) * 100)
  if (rupees === 0 && paise === 0) return "Zero Rupees Only"

  const parts: string[] = []
  const crore = Math.floor(rupees / 10000000)
  const lakh = Math.floor((rupees % 10000000) / 100000)
  const thousand = Math.floor((rupees % 100000) / 1000)
  const hundreds = rupees % 1000

  if (crore) parts.push(`${twoDigits(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundreds) parts.push(threeDigits(hundreds))

  let words = parts.join(" ").trim()
  words = `${value < 0 ? "Minus " : ""}${words} Rupees`
  if (paise) words += ` and ${twoDigits(paise)} Paise`
  return `${words} Only`
}

// ---------------------------------------------------------------------------
// Colours (RGB tuples)
// ---------------------------------------------------------------------------
const INK: [number, number, number] = [17, 24, 39] // #111827
const MUTED: [number, number, number] = [107, 114, 128] // #6b7280
const HEAD: [number, number, number] = [15, 23, 42] // #0f172a slate
const LINE: [number, number, number] = [226, 232, 240] // #e2e8f0
const ZEBRA: [number, number, number] = [244, 246, 250] // very light row tint

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
export function buildFreelanceInvoicePdf(
  inv: FreelanceInvoiceRow,
  company: InvoiceCompany,
  bank: InvoiceBank,
  title = "TAX INVOICE",
): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const M = 40
  const right = W - M

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2])
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])

  let y = 54

  // --- Header: company (left) + invoice title/meta (right) ---
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
    company.website && company.website,
  ].filter(Boolean) as string[]
  for (const line of contactBits) {
    doc.text(line, M, cy)
    cy += 11
  }
  const idBits = [
    company.taxNumber && `${company.taxLabel || "GSTIN"}: ${company.taxNumber}`,
  ].filter(Boolean) as string[]
  for (const line of idBits) {
    doc.text(line, M, cy)
    cy += 11
  }

  // Title block on the right.
  setColor(HEAD)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text(title, right, y, { align: "right" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const meta: Array<[string, string]> = [
    ["Invoice No", String(inv.freelance_invoice_id || "—")],
    ["Invoice Date", fmtDate(inv.invoice_date)],
  ]
  if (inv.financial_year) meta.push(["Financial Year", String(inv.financial_year)])
  if (inv.billing_period) meta.push(["Billing Period", String(inv.billing_period)])
  let my = y + 16
  for (const [label, val] of meta) {
    doc.text(`${label}:`, right - 150, my, { align: "left" })
    setColor(INK)
    doc.text(val, right, my, { align: "right" })
    setColor(MUTED)
    my += 13
  }

  y = Math.max(cy, my) + 8

  // --- Divider ---
  setDraw(HEAD)
  doc.setLineWidth(1.2)
  doc.line(M, y, right, y)
  y += 20

  // --- Billed To (left) / Payment terms (right) ---
  const colGap = 20
  const colW = (right - M - colGap) / 2

  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  setColor(MUTED)
  doc.text("BILLED TO", M, y)
  doc.text("DETAILS", M + colW + colGap, y)
  y += 15

  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  setColor(INK)
  doc.text(String(inv.freelancer_name || "—"), M, y)

  // right column details
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  const details: Array<[string, string]> = []
  if (inv.freelancer_id) details.push(["Freelancer ID", String(inv.freelancer_id)])
  if (inv.project_name) details.push(["Project", String(inv.project_name)])
  if (inv.invoice_bill_reference) details.push(["Reference", String(inv.invoice_bill_reference)])
  if (inv.due_date) details.push(["Due Date", fmtDate(inv.due_date)])
  details.push(["Payment Status", String(inv.payment_status || "Unpaid")])

  const rx = M + colW + colGap
  let ry = y
  for (const [label, val] of details) {
    setColor(MUTED)
    doc.text(`${label}:`, rx, ry)
    setColor(INK)
    doc.text(val, right, ry, { align: "right" })
    ry += 13
  }

  // left column contact lines
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  let ly = y + 14
  const freelancerLines = [
    inv.freelancer_email && `Email: ${inv.freelancer_email}`,
    inv.freelancer_id && `ID: ${inv.freelancer_id}`,
  ].filter(Boolean) as string[]
  for (const line of freelancerLines) {
    doc.text(line, M, ly)
    ly += 12
  }

  y = Math.max(ly, ry) + 14

  // --- Line items table ---
  const cols = {
    sno: M + 4,
    desc: M + 34,
    units: M + 320,
    rate: M + 400,
    amount: right - 4,
  }
  const headerH = 22

  setFill(HEAD)
  doc.rect(M, y, right - M, headerH, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.setTextColor(255, 255, 255)
  const th = y + 14
  doc.text("#", cols.sno, th)
  doc.text("DESCRIPTION", cols.desc, th)
  doc.text("UNITS", cols.units, th, { align: "right" })
  doc.text("RATE", cols.rate, th, { align: "right" })
  doc.text("AMOUNT", cols.amount, th, { align: "right" })
  y += headerH

  // Single line item derived from the invoice record.
  const descLines = doc.splitTextToSize(
    String(inv.work_description || inv.project_name || "Professional / freelance services"),
    cols.units - cols.desc - 12,
  ) as string[]
  const units = inv.units_deliverables ? `${Number(inv.units_deliverables)} ${inv.unit || ""}`.trim() : "—"
  const rate = inv.rate ? grouped(Number(inv.rate)) : "—"

  const rowH = Math.max(24, descLines.length * 11 + 12)
  setFill(ZEBRA)
  doc.rect(M, y, right - M, rowH, "F")

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(INK)
  const rt = y + 15
  doc.text("1", cols.sno, rt)
  doc.text(descLines, cols.desc, rt)
  doc.text(units, cols.units, rt, { align: "right" })
  doc.text(rate, cols.rate, rt, { align: "right" })
  doc.text(grouped(Number(inv.gross_amount) || 0), cols.amount, rt, { align: "right" })
  y += rowH

  setDraw(LINE)
  doc.setLineWidth(0.7)
  doc.line(M, y, right, y)
  y += 18

  // --- Totals (right aligned block) ---
  const totalsX = right - 240
  const totalRows: Array<[string, string]> = [["Gross Amount", money(inv.gross_amount)]]
  if (Number(inv.tds_amount) > 0 || inv.tds_applicable) {
    const tdsLabel = inv.tds_section
      ? `TDS (${inv.tds_section}${inv.tds_rate ? ` @ ${Number(inv.tds_rate)}%` : ""})`
      : "TDS"
    totalRows.push([tdsLabel, `- ${money(inv.tds_amount)}`])
  }
  if (Number(inv.other_adjustment)) totalRows.push(["Other Adjustment", money(inv.other_adjustment)])

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
  setFill(HEAD)
  doc.rect(totalsX - 12, y - 12, right - (totalsX - 12), 26, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(255, 255, 255)
  doc.text("NET PAYABLE", totalsX, y + 5)
  doc.text(money(inv.net_payable), right, y + 5, { align: "right" })
  y += 34

  // --- Amount in words ---
  setColor(MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  doc.text("Amount in words", M, y)
  y += 13
  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  const wordsLines = doc.splitTextToSize(amountInWords(Number(inv.net_payable) || 0), right - M) as string[]
  doc.text(wordsLines, M, y)
  y += wordsLines.length * 12 + 12

  // --- Bank details ---
  if (bank && (bank.accountNumber || bank.bankName)) {
    setDraw(LINE)
    doc.setLineWidth(0.7)
    doc.line(M, y, right, y)
    y += 16
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    setColor(MUTED)
    doc.text("ACCOUNT DETAILS", M, y)
    y += 14
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    const bankRows = [
      bank.accountName && `Account Name: ${bank.accountName}`,
      bank.accountNumber && `Account Number: ${bank.accountNumber}`,
      bank.bankName && `Bank: ${bank.bankName}`,
      bank.ifsc && `IFSC: ${bank.ifsc}`,
      bank.branch && `Branch: ${bank.branch}`,
    ].filter(Boolean) as string[]
    setColor(INK)
    for (const line of bankRows) {
      doc.text(line, M, y)
      y += 12
    }
    y += 8
  }

  // --- Notes ---
  if (inv.notes) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    setColor(MUTED)
    doc.text("NOTES", M, y)
    y += 13
    doc.setFont("helvetica", "normal")
    setColor(INK)
    const noteLines = doc.splitTextToSize(String(inv.notes), right - M) as string[]
    doc.text(noteLines, M, y)
    y += noteLines.length * 12 + 8
  }

  // --- Footer note ---
  const footerY = doc.internal.pageSize.getHeight() - 36
  setDraw(LINE)
  doc.setLineWidth(0.7)
  doc.line(M, footerY - 12, right, footerY - 12)
  setColor(MUTED)
  doc.setFont("helvetica", "italic")
  doc.setFontSize(8)
  doc.text("This is a system-generated invoice. No signature is required.", M, footerY)
  doc.setFont("helvetica", "normal")
  doc.text(company.name || "", right, footerY, { align: "right" })

  return Buffer.from(doc.output("arraybuffer"))
}

/** Shared helper: derive the company block from the settings map. */
export function companyFromSettings(s: Record<string, string>): InvoiceCompany {
  return {
    name: s["company.name"] || "Company",
    addressLines: [
      s["address.line"] || "",
      [s["address.city"], s["address.state"], s["address.postal_code"]].filter(Boolean).join(", "),
      s["address.country"] || "",
    ].filter(Boolean),
    email: s["company.email"] || "",
    phone: s["company.phone"] || "",
    website: s["company.website"] || "",
    taxLabel: s["tax.number_label"] || s["address.tax_name"] || "GSTIN",
    taxNumber: s["address.tax_number"] || "",
  }
}
