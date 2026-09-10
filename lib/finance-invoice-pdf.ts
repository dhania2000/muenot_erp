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

// ===========================================================================
// Indian "Tax Invoice" layout (matches the boxed GST invoice format).
// Used for Sales Invoices and Purchase Bills.
// ===========================================================================

export type TaxInvoiceParty = {
  name: string
  addressLines: string[]
  taxLabel: string
  taxNumber: string
}

export type TaxInvoiceLine = {
  description: string
  hsnSac: string
  quantity: string
  rate: string
  amount: string
}

export type TaxInvoiceTaxRow = {
  label: string
  rate: string
  amount: string
}

export type TaxInvoiceSupplierDetails = {
  pan?: string
  email?: string
  bankName?: string
  accountNumber?: string
  accountHolder?: string
  branchIfsc?: string
}

export type TaxInvoiceData = {
  title: string
  invoiceNo: string
  invoiceDate: string
  poNumber?: string
  poDate?: string
  otherReference?: string
  supplierContact?: string
  projectName?: string
  supplier: TaxInvoiceParty
  buyer: TaxInvoiceParty
  lines: TaxInvoiceLine[]
  taxableValue: string
  taxRows: TaxInvoiceTaxRow[]
  totalTax: string
  invoiceAmount: string
  amountInWords: string
  supplierDetails?: TaxInvoiceSupplierDetails
}

/** Build a boxed Indian GST tax-invoice PDF. */
export function buildTaxInvoicePdf(data: TaxInvoiceData): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const M = 32
  const right = W - M
  const contentW = right - M

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2])
  doc.setLineWidth(0.7)

  // Title
  let y = 46
  setColor(HEAD)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(16)
  doc.text(data.title, W / 2, y, { align: "center" })
  y += 16

  setDraw(INK)

  // Helper to render a wrapped label/value stack, returns the new y.
  const splitW = (text: string, w: number) => doc.splitTextToSize(text, w) as string[]

  // ---- Party + meta block --------------------------------------------------
  const leftW = contentW * 0.56
  const rightX = M + leftW
  const rightW = contentW - leftW
  const partyTop = y

  // Left: supplier party
  const pad = 8
  setColor(MUTED)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(7.5)
  doc.text("SUPPLIER", M + pad, partyTop + 14)

  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10.5)
  const supNameLines = splitW(data.supplier.name || "—", leftW - pad * 2)
  let ly = partyTop + 28
  doc.text(supNameLines, M + pad, ly)
  ly += supNameLines.length * 12

  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  setColor(MUTED)
  for (const line of data.supplier.addressLines.filter(Boolean)) {
    const wrapped = splitW(line, leftW - pad * 2)
    doc.text(wrapped, M + pad, ly)
    ly += wrapped.length * 11
  }
  if (data.supplier.taxNumber) {
    setColor(INK)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.text(`${data.supplier.taxLabel || "GSTIN"}: ${data.supplier.taxNumber}`, M + pad, ly + 2)
    ly += 14
  }

  // Right: meta grid
  const meta: Array<[string, string]> = [
    ["Invoice No.", data.invoiceNo || "—"],
    ["Date", data.invoiceDate || "—"],
    ["PO Number", data.poNumber || "—"],
    ["PO Date", data.poDate || "—"],
    ["Supplier's Contact", data.supplierContact || "—"],
    ["Other Reference(s)", data.otherReference || "—"],
  ]
  const metaRowH = 18
  let my = partyTop
  const labelW = rightW * 0.5
  for (const [label, val] of meta) {
    // vertical split between label and value
    doc.line(rightX + labelW, my, rightX + labelW, my + metaRowH)
    setColor(MUTED)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text(label, rightX + 6, my + 12)
    setColor(INK)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.text(splitW(val, rightW - labelW - 10)[0], rightX + labelW + 6, my + 12)
    my += metaRowH
    doc.line(rightX, my, right, my)
  }

  const partyBottom = Math.max(ly + 6, my)
  // outer + divider for party block
  doc.rect(M, partyTop, contentW, partyBottom - partyTop)
  doc.line(rightX, partyTop, rightX, partyBottom)
  y = partyBottom

  // ---- Buyer + project block ----------------------------------------------
  const buyerTop = y
  setColor(MUTED)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(7.5)
  doc.text("BUYER", M + pad, buyerTop + 14)

  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10.5)
  const buyNameLines = splitW(data.buyer.name || "—", leftW - pad * 2)
  let by = buyerTop + 28
  doc.text(buyNameLines, M + pad, by)
  by += buyNameLines.length * 12

  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  setColor(MUTED)
  for (const line of data.buyer.addressLines.filter(Boolean)) {
    const wrapped = splitW(line, leftW - pad * 2)
    doc.text(wrapped, M + pad, by)
    by += wrapped.length * 11
  }
  if (data.buyer.taxNumber) {
    setColor(INK)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.text(`${data.buyer.taxLabel || "GSTIN"}: ${data.buyer.taxNumber}`, M + pad, by + 2)
    by += 14
  }

  // Right: project name
  setColor(MUTED)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(7.5)
  doc.text("PROJECT NAME", rightX + 6, buyerTop + 14)
  setColor(INK)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  const projLines = splitW(data.projectName || "—", rightW - 12)
  doc.text(projLines, rightX + 6, buyerTop + 28)

  const buyerBottom = Math.max(by + 6, buyerTop + 28 + projLines.length * 11 + 6)
  doc.rect(M, buyerTop, contentW, buyerBottom - buyerTop)
  doc.line(rightX, buyerTop, rightX, buyerBottom)
  y = buyerBottom

  // ---- Line items table ----------------------------------------------------
  // Columns: # | Description | HSN/SAC | Qty | Rate | Total
  const cx = {
    sno: M,
    desc: M + 26,
    hsn: right - 260,
    qty: right - 190,
    rate: right - 120,
    total: right,
  }
  const colLines = [cx.desc, cx.hsn, cx.qty, cx.rate, right - 60]

  const thH = 20
  setDraw(INK)
  doc.setFillColor(HEAD[0], HEAD[1], HEAD[2])
  doc.rect(M, y, contentW, thH, "F")
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8)
  const thy = y + 13
  doc.text("#", cx.sno + 6, thy)
  doc.text("DESCRIPTION OF GOODS / SERVICES", cx.desc + 6, thy)
  doc.text("HSN/SAC", cx.hsn + 4, thy)
  doc.text("QTY", cx.qty + 30, thy, { align: "right" })
  doc.text("RATE", cx.rate + 25, thy, { align: "right" })
  doc.text("TOTAL", cx.total - 6, thy, { align: "right" })
  y += thH

  doc.setTextColor(INK[0], INK[1], INK[2])
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  const rowTop = y
  data.lines.forEach((line, i) => {
    const descLines = splitW(line.description || "—", cx.hsn - cx.desc - 12)
    const rowH = Math.max(22, descLines.length * 11 + 10)
    const ty = y + 14
    doc.text(String(i + 1), cx.sno + 6, ty)
    doc.text(descLines, cx.desc + 6, ty)
    doc.text(line.hsnSac || "—", cx.hsn + 4, ty)
    doc.text(line.quantity || "—", cx.qty + 30, ty, { align: "right" })
    doc.text(line.rate || "—", cx.rate + 25, ty, { align: "right" })
    doc.text(line.amount || "—", cx.total - 6, ty, { align: "right" })
    y += rowH
    setDraw(LINE)
    doc.line(M, y, right, y)
    setDraw(INK)
  })

  // pad the table to a minimum height for a tidy look
  const minTableBottom = rowTop + 60
  if (y < minTableBottom) y = minTableBottom

  // Taxable value subtotal row
  const subH = 18
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  setColor(MUTED)
  doc.text("Taxable Value", cx.rate + 25, y + 13, { align: "right" })
  setColor(INK)
  doc.text(data.taxableValue, cx.total - 6, y + 13, { align: "right" })
  y += subH

  const tableBottom = y
  // table outer + vertical column separators
  doc.rect(M, rowTop - thH, contentW, tableBottom - (rowTop - thH))
  for (const cxLine of colLines) doc.line(cxLine, rowTop - thH, cxLine, tableBottom - subH)
  y = tableBottom

  // ---- Tax summary table ---------------------------------------------------
  const taxTop = y
  const tHeaderH = 18
  const taxColLabel = M
  const taxColRate = M + contentW * 0.45
  const taxColAmt = M + contentW * 0.7

  doc.setFillColor(240, 242, 246)
  doc.rect(M, taxTop, contentW, tHeaderH, "F")
  setColor(MUTED)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(7.5)
  doc.text("TAX", taxColLabel + 6, taxTop + 12)
  doc.text("RATE", taxColRate + 6, taxTop + 12)
  doc.text("GST AMOUNT", right - 6, taxTop + 12, { align: "right" })
  y = taxTop + tHeaderH

  setColor(INK)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  const taxRows = data.taxRows.length ? data.taxRows : [{ label: "GST", rate: "0%", amount: data.totalTax }]
  taxRows.forEach((tr, i) => {
    const ry = y + 13
    doc.text(tr.label, taxColLabel + 6, ry)
    doc.text(tr.rate, taxColRate + 6, ry)
    doc.text(tr.amount, right - 6, ry, { align: "right" })
    y += 18
    if (i < taxRows.length - 1) {
      setDraw(LINE)
      doc.line(M, y, right, y)
      setDraw(INK)
    }
  })

  const taxBottom = y
  doc.rect(M, taxTop, contentW, taxBottom - taxTop)
  doc.line(taxColRate, taxTop, taxColRate, taxBottom)
  doc.line(taxColAmt, taxTop, taxColAmt, taxBottom)
  y = taxBottom

  // Invoice amount highlight bar (full width, no overlapping dividers).
  const barH = 26
  doc.setFillColor(HEAD[0], HEAD[1], HEAD[2])
  doc.rect(M, y, contentW, barH, "F")
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.text("INVOICE AMOUNT", M + 8, y + 17)
  doc.setFontSize(13)
  doc.text(data.invoiceAmount, right - 8, y + 18, { align: "right" })
  y += barH
  setColor(INK)

  // ---- Amount in words -----------------------------------------------------
  const wordsTop = y
  setColor(MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.text("Amount Chargeable (in words)", M + 6, wordsTop + 13)
  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  const wordsLines = splitW(data.amountInWords, contentW - 12)
  doc.text(wordsLines, M + 6, wordsTop + 27)
  const wordsBottom = wordsTop + 27 + wordsLines.length * 12 + 6
  doc.rect(M, wordsTop, contentW, wordsBottom - wordsTop)
  y = wordsBottom

  // ---- Supplier's details (PAN / email / bank) -----------------------------
  const sd = data.supplierDetails
  if (sd && (sd.pan || sd.email || sd.bankName || sd.accountNumber)) {
    const sdTop = y
    setColor(MUTED)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    doc.text("SUPPLIER'S DETAILS", M + 6, sdTop + 13)
    setColor(INK)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    const rows = [
      sd.pan && `PAN: ${sd.pan}`,
      sd.email && `Email: ${sd.email}`,
      sd.bankName && `Bank Name: ${sd.bankName}`,
      sd.accountNumber && `A/c No.: ${sd.accountNumber}`,
      sd.accountHolder && `Account Holder: ${sd.accountHolder}`,
      sd.branchIfsc && `Branch & IFSC: ${sd.branchIfsc}`,
    ].filter(Boolean) as string[]
    let sy = sdTop + 26
    for (const r of rows) {
      doc.text(r, M + 6, sy)
      sy += 12
    }
    const sdBottom = sy + 4
    doc.rect(M, sdTop, contentW, sdBottom - sdTop)
    y = sdBottom
  }

  // ---- Footer: authorized signatory ---------------------------------------
  const sigTop = y
  const sigH = 56
  doc.rect(M, sigTop, contentW, sigH)
  setColor(MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.text(`For ${data.supplier.name || ""}`, right - 12, sigTop + 16, { align: "right" })
  doc.text("Authorized Signatory", right - 12, sigTop + sigH - 8, { align: "right" })
  doc.setFont("helvetica", "italic")
  doc.setFontSize(7.5)
  doc.text("E. & O.E.", M + 6, sigTop + sigH - 8)

  return Buffer.from(doc.output("arraybuffer"))
}

// ---------------------------------------------------------------------------
// Mapping helpers: DB row -> TaxInvoiceData
// ---------------------------------------------------------------------------

/** Derive a PAN from a GSTIN (chars 3-12) when a PAN is not stored separately. */
function panFromGstin(gstin?: string): string {
  if (!gstin || gstin.length < 12) return ""
  return gstin.slice(2, 12)
}

function taxRowsFrom(row: Record<string, any>): TaxInvoiceTaxRow[] {
  const out: TaxInvoiceTaxRow[] = []
  const igst = Number(row.igst_amount) || 0
  const cgst = Number(row.cgst_amount) || 0
  const sgst = Number(row.sgst_amount) || 0
  const cess = Number(row.other_tax_cess) || 0
  if (igst > 0) out.push({ label: "IGST", rate: `${Number(row.igst_percent) || 0}%`, amount: grouped(igst) })
  if (cgst > 0) out.push({ label: "CGST", rate: `${Number(row.cgst_percent) || 0}%`, amount: grouped(cgst) })
  if (sgst > 0) out.push({ label: "SGST", rate: `${Number(row.sgst_percent) || 0}%`, amount: grouped(sgst) })
  if (cess > 0) out.push({ label: "Cess / Other", rate: "—", amount: grouped(cess) })
  return out
}

function qtyLabel(qty: any, unit?: any): string {
  const n = Number(qty) || 0
  if (!n) return "—"
  return `${grouped(n).replace(/\.00$/, "")}${unit ? " " + unit : ""}`
}

export type PartyLike = {
  name?: string | null
  gstNumber?: string | null
  taxLabel?: string | null
  addressLines?: (string | null | undefined)[]
}

/** Sales invoice -> Tax Invoice (supplier = own company, buyer = client). */
export function buildSalesInvoicePdf(
  inv: Record<string, any>,
  company: InvoiceCompany,
  buyer: PartyLike,
  bank: InvoiceBank,
): Buffer {
  const totalTax =
    (Number(inv.cgst_amount) || 0) +
    (Number(inv.sgst_amount) || 0) +
    (Number(inv.igst_amount) || 0) +
    (Number(inv.other_tax_cess) || 0)

  return buildTaxInvoicePdf({
    title: inv.invoice_type ? String(inv.invoice_type).toUpperCase() : "TAX INVOICE",
    invoiceNo: String(inv.invoice_id || "—"),
    invoiceDate: fmtDate(inv.invoice_date),
    supplierContact: company.phone,
    otherReference: inv.credit_debit_note_ref || inv.irn_reference || undefined,
    projectName: inv.project_name || undefined,
    supplier: {
      name: company.name,
      addressLines: company.addressLines,
      taxLabel: company.taxLabel || "GSTIN",
      taxNumber: company.taxNumber,
    },
    buyer: {
      name: buyer.name || inv.client_name || "—",
      addressLines: (buyer.addressLines || []).filter(Boolean) as string[],
      taxLabel: buyer.taxLabel || "GSTIN",
      taxNumber: buyer.gstNumber || "",
    },
    lines: [
      {
        description: inv.description || inv.project_name || "Services",
        hsnSac: inv.hsn_sac || "—",
        quantity: qtyLabel(inv.quantity, inv.unit),
        rate: Number(inv.rate) ? grouped(Number(inv.rate)) : "—",
        amount: grouped(Number(inv.taxable_amount) || 0),
      },
    ],
    taxableValue: grouped(Number(inv.taxable_amount) || 0),
    taxRows: taxRowsFrom(inv),
    totalTax: grouped(totalTax),
    invoiceAmount: money(inv.invoice_total),
    amountInWords: amountInWords(Number(inv.invoice_total) || 0),
    supplierDetails: {
      pan: panFromGstin(company.taxNumber),
      email: company.email,
      bankName: bank?.bankName,
      accountNumber: bank?.accountNumber,
      accountHolder: bank?.accountName,
      branchIfsc: bank ? [bank.branch, bank.ifsc].filter(Boolean).join(" / ") : undefined,
    },
  })
}

/** Purchase bill -> Tax Invoice (supplier = vendor, buyer = own company). */
export function buildPurchaseBillPdf(
  bill: Record<string, any>,
  company: InvoiceCompany,
): Buffer {
  const totalTax =
    (Number(bill.cgst_amount) || 0) +
    (Number(bill.sgst_amount) || 0) +
    (Number(bill.igst_amount) || 0) +
    (Number(bill.other_tax_cess) || 0)

  return buildTaxInvoicePdf({
    title: bill.bill_type ? String(bill.bill_type).toUpperCase() : "PURCHASE BILL",
    invoiceNo: String(bill.po_number || "—"),
    invoiceDate: fmtDate(bill.bill_date),
    poNumber: bill.po_number || undefined,
    projectName: bill.project_name || undefined,
    supplier: {
      name: bill.vendor_name || "—",
      addressLines: bill.vendor_id ? [`Vendor ID: ${bill.vendor_id}`] : [],
      taxLabel: "GSTIN",
      taxNumber: "",
    },
    buyer: {
      name: company.name,
      addressLines: company.addressLines,
      taxLabel: company.taxLabel || "GSTIN",
      taxNumber: company.taxNumber,
    },
    lines: [
      {
        description: bill.description || bill.project_name || "Purchased goods / services",
        hsnSac: bill.hsn_sac || "—",
        quantity: qtyLabel(bill.quantity, bill.unit),
        rate: Number(bill.rate) ? grouped(Number(bill.rate)) : "—",
        amount: grouped(Number(bill.taxable_amount) || 0),
      },
    ],
    taxableValue: grouped(Number(bill.taxable_amount) || 0),
    taxRows: taxRowsFrom(bill),
    totalTax: grouped(totalTax),
    invoiceAmount: money(bill.gross_bill_amount),
    amountInWords: amountInWords(Number(bill.gross_bill_amount) || 0),
  })
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
