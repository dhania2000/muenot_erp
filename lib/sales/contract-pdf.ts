import "server-only"
import { jsPDF } from "jspdf"
import type { InvoiceCompany } from "@/lib/finance-invoice-pdf"

/**
 * Professional Sales Contract PDF.
 *
 * Reuses the jsPDF palette and conventions from lib/finance-invoice-pdf.ts and
 * lib/sales/quotation-pdf.ts so contracts look consistent with the rest of the
 * document suite. Lays out the contract-specific blocks: parties, term,
 * value, terms & conditions, and a signature block reflecting the current
 * e-signature state.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function fmtDate(v: any): string {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function fmtDateTime(v: any): string {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${fmtDate(v)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

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

const INK: [number, number, number] = [17, 24, 39]
const MUTED: [number, number, number] = [107, 114, 128]
const HEAD: [number, number, number] = [15, 23, 42]
const LINE: [number, number, number] = [226, 232, 240]

export type ContractPdfData = Record<string, any> & {
  contract_code: string
  title?: string | null
  contract_date?: string | null
  company_name?: string | null
  start_date?: string | null
  end_date?: string | null
  value?: number
  contract_type?: string | null
  status?: string | null
  terms?: string | null
  notes?: string | null
  signed_by_client?: string | null
  signed_by_company?: string | null
  signed_client_at?: string | null
  signed_company_at?: string | null
  version_no?: number
  relation?: string | null
}

export function buildContractPdf(c: ContractPdfData, company: InvoiceCompany): Buffer {
  const cur = (n: any) => `INR ${grouped(Number(n) || 0)}`
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 40
  const right = W - M

  const setColor = (col: [number, number, number]) => doc.setTextColor(col[0], col[1], col[2])
  const setDraw = (col: [number, number, number]) => doc.setDrawColor(col[0], col[1], col[2])

  let y = 54

  // --- Header ---
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
  ].filter(Boolean) as string[]
  for (const line of contactBits) {
    doc.text(line, M, cy)
    cy += 11
  }

  setColor(HEAD)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text("CONTRACT", right, y, { align: "right" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const meta: Array<[string, string]> = [
    ["Contract No", `${c.contract_code}${c.version_no && c.version_no > 1 ? ` (V${c.version_no})` : ""}`],
    ["Date", fmtDate(c.contract_date)],
    ["Type", String(c.contract_type || "—")],
    ["Status", String(c.status || "—")],
  ]
  if (c.relation && c.relation !== "Original") meta.push(["Relation", String(c.relation)])
  let my = y + 16
  for (const [label, val] of meta) {
    doc.text(`${label}:`, right - 175, my, { align: "left" })
    setColor(INK)
    doc.text(val, right, my, { align: "right" })
    setColor(MUTED)
    my += 14
  }

  y = Math.max(cy, my) + 14
  setDraw(LINE)
  doc.line(M, y, right, y)
  y += 22

  // --- Title ---
  if (c.title) {
    setColor(INK)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(13)
    const titleLines = doc.splitTextToSize(String(c.title), W - M * 2)
    doc.text(titleLines, M, y)
    y += titleLines.length * 16 + 8
  }

  // --- Parties + term ---
  setColor(HEAD)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text("Parties", M, y)
  doc.text("Term & Value", W / 2 + 10, y)
  y += 15

  setColor(INK)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9.5)
  const partyLines = [
    `Provider: ${company.name || "—"}`,
    `Client: ${c.company_name || "—"}`,
  ]
  const termLines = [
    `Start: ${fmtDate(c.start_date)}`,
    `End: ${fmtDate(c.end_date)}`,
    `Contract Value: ${cur(c.value)}`,
  ]
  const rows = Math.max(partyLines.length, termLines.length)
  for (let i = 0; i < rows; i++) {
    if (partyLines[i]) doc.text(partyLines[i], M, y)
    if (termLines[i]) doc.text(termLines[i], W / 2 + 10, y)
    y += 13
  }
  y += 12

  // --- Terms & conditions ---
  const ensureSpace = (needed: number) => {
    if (y + needed > H - 120) {
      doc.addPage()
      y = 54
    }
  }

  if (c.terms) {
    ensureSpace(40)
    setColor(HEAD)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text("Terms & Conditions", M, y)
    y += 15
    setColor(INK)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    const lines = doc.splitTextToSize(String(c.terms), W - M * 2)
    for (const line of lines) {
      ensureSpace(14)
      doc.text(line, M, y)
      y += 12
    }
    y += 10
  }

  if (c.notes) {
    ensureSpace(30)
    setColor(HEAD)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text("Notes", M, y)
    y += 15
    setColor(MUTED)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    const lines = doc.splitTextToSize(String(c.notes), W - M * 2)
    for (const line of lines) {
      ensureSpace(14)
      doc.text(line, M, y)
      y += 12
    }
    y += 10
  }

  // --- Signature block ---
  ensureSpace(120)
  y = Math.max(y, H - 150)
  setDraw(LINE)
  doc.line(M, y, right, y)
  y += 24

  const colW = (W - M * 2) / 2
  const drawSignatory = (x: number, heading: string, name: string | null, at: any) => {
    setColor(MUTED)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.text(heading, x, y)
    setDraw(LINE)
    doc.line(x, y + 40, x + colW - 20, y + 40)
    setColor(INK)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.text(name || "________________________", x, y + 54)
    setColor(MUTED)
    doc.setFontSize(8)
    doc.text(at ? `Signed: ${fmtDateTime(at)}` : "Signature / Date", x, y + 66)
  }
  drawSignatory(M, "FOR THE CLIENT", c.signed_by_client || null, c.signed_client_at)
  drawSignatory(M + colW, "FOR THE PROVIDER", c.signed_by_company || null, c.signed_company_at)

  // --- Footer ---
  const pageCount = (doc as any).internal.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    setColor(MUTED)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.text(
      `${c.contract_code} · Generated ${fmtDate(new Date())}`,
      M,
      H - 24,
    )
    doc.text(`Page ${p} of ${pageCount}`, right, H - 24, { align: "right" })
  }

  return Buffer.from(doc.output("arraybuffer"))
}
