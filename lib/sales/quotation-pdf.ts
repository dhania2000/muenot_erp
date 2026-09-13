import "server-only"
import { jsPDF } from "jspdf"
import type { InvoiceCompany, InvoiceBank } from "@/lib/finance-invoice-pdf"

/**
 * Professional Sales Quotation PDF.
 *
 * Reuses the same jsPDF conventions, palette and Indian number/word helpers as
 * lib/finance-invoice-pdf.ts so quotations look consistent with invoices, but
 * lays out the quotation-specific blocks: validity, multi-line items with
 * per-line discount + tax, CGST/SGST/IGST summary, terms and notes. The stored
 * server-computed totals are printed verbatim — no numbers are recomputed here.
 */

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

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h) parts.push(`${ONES[h]} Hundred`)
  if (rest) parts.push(twoDigits(rest))
  return parts.join(" ")
}

function amountInWords(value: number, currency: string): string {
  const unit = currency === "INR" ? "Rupees" : currency
  const whole = Math.floor(Math.abs(value))
  const frac = Math.round((Math.abs(value) - whole) * 100)
  if (whole === 0 && frac === 0) return `Zero ${unit} Only`
  const parts: string[] = []
  const crore = Math.floor(whole / 10000000)
  const lakh = Math.floor((whole % 10000000) / 100000)
  const thousand = Math.floor((whole % 100000) / 1000)
  const hundreds = whole % 1000
  if (crore) parts.push(`${twoDigits(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundreds) parts.push(threeDigits(hundreds))
  let words = `${value < 0 ? "Minus " : ""}${parts.join(" ").trim()} ${unit}`
  if (frac) words += ` and ${twoDigits(frac)} Paise`
  return `${words} Only`
}

const INK: [number, number, number] = [17, 24, 39]
const MUTED: [number, number, number] = [107, 114, 128]
const HEAD: [number, number, number] = [15, 23, 42]
const LINE: [number, number, number] = [226, 232, 240]
const ZEBRA: [number, number, number] = [244, 246, 250]

export type QuotationPdfItem = {
  name: string
  description?: string | null
  hsn_sac?: string | null
  quantity: number
  unit?: string | null
  rate: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  line_total: number
}

export type QuotationPdfData = Record<string, any> & {
  quote_code: string
  version?: number
  quote_date?: string | null
  valid_until?: string | null
  currency?: string | null
  company_name?: string | null
  contact_person?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  bill_to_address?: string | null
  ship_to_address?: string | null
  opportunity_name?: string | null
  reference?: string | null
  owner_name?: string | null
  subtotal: number
  discount_total: number
  taxable_value: number
  cgst_total: number
  sgst_total: number
  igst_total: number
  tax_total: number
  round_off: number
  grand_total: number
  payment_terms?: string | null
  delivery_terms?: string | null
  terms_text?: string | null
  customer_notes?: string | null
}

/** Build a professional quotation PDF and return it as a Buffer. */
export function buildQuotationPdf(
  q: QuotationPdfData,
  items: QuotationPdfItem[],
  company: InvoiceCompany,
  bank: InvoiceBank,
): Buffer {
  const currency = (q.currency || "INR").toUpperCase()
  const cur = (n: any) => `${currency} ${grouped(Number(n) || 0)}`

  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 40
  const right = W - M

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2])
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])

  let y = 54

  // --- Header: company (left) + QUOTATION title/meta (right) ---
  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(company.name || "Company", M, y)

  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  setColor(MUTED)
  let cy = y + 15
  for (const line of (company.addressLines || []).filter(Boolean)) {
    doc.text(line, M, cy)
    cy += 11
  }
  const contactBits = [
    company.email && `Email: ${company.email}`,
    company.phone && `Phone: ${company.phone}`,
    company.website && company.website,
    company.taxNumber && `${company.taxLabel || "GSTIN"}: ${company.taxNumber}`,
  ].filter(Boolean) as string[]
  for (const line of contactBits) {
    doc.text(line, M, cy)
    cy += 11
  }

  setColor(HEAD)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text("QUOTATION", right, y, { align: "right" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const meta: Array<[string, string]> = [
    ["Quotation No", `${q.quote_code}${q.version && q.version > 1 ? ` (V${q.version})` : ""}`],
    ["Date", fmtDate(q.quote_date)],
    ["Valid Until", fmtDate(q.valid_until)],
  ]
  if (q.reference) meta.push(["Reference", String(q.reference)])
  if (q.owner_name) meta.push(["Sales Owner", String(q.owner_name)])
  let my = y + 16
  for (const [label, val] of meta) {
    doc.text(`${label}:`, right - 170, my, { align: "left" })
    setColor(INK)
    doc.text(val, right, my, { align: "right" })
    setColor(MUTED)
    my += 13
  }

  y = Math.max(cy, my) + 8
  setDraw(HEAD)
  doc.setLineWidth(1.2)
  doc.line(M, y, right, y)
  y += 20

  // --- Prepared For (left) / Opportunity + addresses (right) ---
  const colGap = 20
  const colW = (right - M - colGap) / 2
  const rx = M + colW + colGap

  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  setColor(MUTED)
  doc.text("PREPARED FOR", M, y)
  if (q.opportunity_name) doc.text("OPPORTUNITY", rx, y)
  y += 15

  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  setColor(INK)
  doc.text(String(q.company_name || "—"), M, y)

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  let ly = y + 14
  const forLines = [
    q.contact_person && q.contact_person,
    q.contact_email && `Email: ${q.contact_email}`,
    q.contact_phone && `Phone: ${q.contact_phone}`,
    q.bill_to_address && `Bill To: ${q.bill_to_address}`,
    q.ship_to_address && `Ship To: ${q.ship_to_address}`,
  ].filter(Boolean) as string[]
  for (const line of forLines) {
    const wrapped = doc.splitTextToSize(line, colW) as string[]
    doc.text(wrapped, M, ly)
    ly += wrapped.length * 12
  }

  let ry = y
  if (q.opportunity_name) {
    setColor(INK)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    const oppLines = doc.splitTextToSize(String(q.opportunity_name), colW) as string[]
    doc.text(oppLines, rx, ry)
    ry += oppLines.length * 12
  }

  y = Math.max(ly, ry) + 14

  // --- Line items table ---
  const cols = {
    sno: M + 4,
    desc: M + 26,
    qty: right - 250,
    rate: right - 175,
    disc: right - 105,
    amount: right - 4,
  }
  const drawTableHeader = (startY: number) => {
    setFill(HEAD)
    doc.rect(M, startY, right - M, 22, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    doc.setTextColor(255, 255, 255)
    const th = startY + 14
    doc.text("#", cols.sno, th)
    doc.text("DESCRIPTION", cols.desc, th)
    doc.text("QTY", cols.qty, th, { align: "right" })
    doc.text("RATE", cols.rate, th, { align: "right" })
    doc.text("DISC", cols.disc, th, { align: "right" })
    doc.text("AMOUNT", cols.amount, th, { align: "right" })
    return startY + 22
  }
  y = drawTableHeader(y)

  doc.setFontSize(9)
  items.forEach((it, idx) => {
    const nameLines = doc.splitTextToSize(it.name, cols.qty - cols.desc - 12) as string[]
    const descLines = it.description
      ? (doc.splitTextToSize(String(it.description), cols.qty - cols.desc - 12) as string[])
      : []
    const hsn = it.hsn_sac ? [`HSN/SAC: ${it.hsn_sac}`] : []
    const bodyLines = [...descLines, ...hsn]
    const rowH = Math.max(22, nameLines.length * 11 + bodyLines.length * 10 + 12)

    // Page break if the row would overflow the footer zone.
    if (y + rowH > H - 90) {
      doc.addPage()
      y = 54
      y = drawTableHeader(y)
    }

    if (idx % 2 === 1) {
      setFill(ZEBRA)
      doc.rect(M, y, right - M, rowH, "F")
    }

    const rt = y + 14
    setColor(INK)
    doc.setFont("helvetica", "normal")
    doc.text(String(idx + 1), cols.sno, rt)
    doc.setFont("helvetica", "bold")
    doc.text(nameLines, cols.desc, rt)
    let subY = rt + nameLines.length * 11
    if (bodyLines.length) {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      setColor(MUTED)
      doc.text(bodyLines, cols.desc, subY)
      doc.setFontSize(9)
      subY += bodyLines.length * 10
    }
    setColor(INK)
    doc.setFont("helvetica", "normal")
    const qtyLabel = `${Number(it.quantity)}${it.unit ? " " + it.unit : ""}`
    doc.text(qtyLabel, cols.qty, rt, { align: "right" })
    doc.text(grouped(Number(it.rate)), cols.rate, rt, { align: "right" })
    doc.text(it.discount_amount ? grouped(Number(it.discount_amount)) : "—", cols.disc, rt, { align: "right" })
    doc.text(grouped(Number(it.line_total)), cols.amount, rt, { align: "right" })
    y += rowH
    setDraw(LINE)
    doc.setLineWidth(0.5)
    doc.line(M, y, right, y)
  })

  y += 16

  // --- Totals block (right aligned) ---
  if (y > H - 170) {
    doc.addPage()
    y = 54
  }
  const totalsX = right - 240
  const totalRows: Array<[string, string]> = [["Subtotal", cur(q.subtotal)]]
  if (Number(q.discount_total) > 0) totalRows.push(["Discount", `- ${cur(q.discount_total)}`])
  totalRows.push(["Taxable Value", cur(q.taxable_value)])
  if (Number(q.cgst_total) > 0) totalRows.push(["CGST", cur(q.cgst_total)])
  if (Number(q.sgst_total) > 0) totalRows.push(["SGST", cur(q.sgst_total)])
  if (Number(q.igst_total) > 0) totalRows.push(["IGST", cur(q.igst_total)])
  if (Number(q.tax_total) > 0 && !(Number(q.cgst_total) || Number(q.sgst_total) || Number(q.igst_total)))
    totalRows.push(["Tax", cur(q.tax_total)])
  if (Number(q.round_off)) totalRows.push(["Round Off", cur(q.round_off)])

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
  doc.text("GRAND TOTAL", totalsX, y + 5)
  doc.text(cur(q.grand_total), right, y + 5, { align: "right" })
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
  const wordsLines = doc.splitTextToSize(amountInWords(Number(q.grand_total) || 0, currency), right - M) as string[]
  doc.text(wordsLines, M, y)
  y += wordsLines.length * 12 + 12

  // --- Terms & notes ---
  const blocks: Array<[string, string]> = []
  const termBits = [
    q.payment_terms && `Payment: ${q.payment_terms}`,
    q.delivery_terms && `Delivery: ${q.delivery_terms}`,
    q.valid_until && `Valid Until: ${fmtDate(q.valid_until)}`,
  ].filter(Boolean) as string[]
  if (termBits.length || q.terms_text) {
    blocks.push(["TERMS & CONDITIONS", [termBits.join("\n"), q.terms_text || ""].filter(Boolean).join("\n")])
  }
  if (q.customer_notes) blocks.push(["NOTES", String(q.customer_notes)])

  for (const [title, body] of blocks) {
    const bodyLines = doc.splitTextToSize(body, right - M) as string[]
    if (y + 16 + bodyLines.length * 11 > H - 70) {
      doc.addPage()
      y = 54
    }
    setDraw(LINE)
    doc.setLineWidth(0.7)
    doc.line(M, y, right, y)
    y += 16
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    setColor(MUTED)
    doc.text(title, M, y)
    y += 13
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    setColor(INK)
    doc.text(bodyLines, M, y)
    y += bodyLines.length * 11 + 10
  }

  // --- Bank details (optional) ---
  if (bank && (bank.accountNumber || bank.bankName)) {
    if (y > H - 110) {
      doc.addPage()
      y = 54
    }
    setDraw(LINE)
    doc.setLineWidth(0.7)
    doc.line(M, y, right, y)
    y += 16
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    setColor(MUTED)
    doc.text("PAYMENT DETAILS", M, y)
    y += 14
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    setColor(INK)
    const bankRows = [
      bank.accountName && `Account Name: ${bank.accountName}`,
      bank.accountNumber && `Account Number: ${bank.accountNumber}`,
      bank.bankName && `Bank: ${bank.bankName}`,
      bank.ifsc && `IFSC: ${bank.ifsc}`,
      bank.branch && `Branch: ${bank.branch}`,
    ].filter(Boolean) as string[]
    for (const line of bankRows) {
      doc.text(line, M, y)
      y += 12
    }
  }

  // --- Footer + signatory on every page ---
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    const footerY = H - 36
    setDraw(LINE)
    doc.setLineWidth(0.7)
    doc.line(M, footerY - 12, right, footerY - 12)
    setColor(MUTED)
    doc.setFont("helvetica", "italic")
    doc.setFontSize(8)
    doc.text("This is a system-generated quotation.", M, footerY)
    doc.setFont("helvetica", "normal")
    doc.text(`For ${company.name || ""}  (Authorised Signatory)`, right, footerY, { align: "right" })
    doc.setFontSize(7.5)
    doc.text(`Page ${p} of ${pageCount}`, W / 2, footerY, { align: "center" })
  }

  return Buffer.from(doc.output("arraybuffer"))
}
