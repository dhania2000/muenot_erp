// ---------------------------------------------------------------------------
// HR Letters — reusable formal letter PDF builder (jsPDF).
//
// Produces a professional A4 portrait letter: company letterhead, reference +
// date row, subject line, flowing body with automatic pagination, and a
// signature block. Consumed by the letter PDF route, the offboarding/promotion
// document generators, and any place that needs a printable letter.
// ---------------------------------------------------------------------------

import { jsPDF } from "jspdf"

export type LetterPdfInput = {
  letterNumber: string
  subject: string
  body: string
  issueDate: string | Date | null | undefined
  recipientName?: string | null
  recipientMeta?: string | null // e.g. "EMP-0042 · Senior Engineer, Engineering"
  company: {
    name?: string
    address?: string
    email?: string
    phone?: string
    website?: string
  }
  signatory?: {
    name?: string | null
    designation?: string | null
    label?: string | null // defaults to "For {company}"
  }
}

const INK = { r: 17, g: 24, b: 39 } // slate-900
const MUTED = { r: 100, g: 116, b: 139 } // slate-500
const RULE = { r: 203, g: 213, b: 225 } // slate-300
const NAVY = { r: 30, g: 58, b: 95 }

function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return ""
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

/** Build the letter and return the jsPDF instance (caller decides output). */
export function buildLetterPdf(input: LetterPdfInput): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 56
  const contentW = pageW - margin * 2
  const bottom = pageH - margin - 40
  let y = margin

  const company = input.company || {}

  const setColor = (c: { r: number; g: number; b: number }) => doc.setTextColor(c.r, c.g, c.b)

  // --- Letterhead ---------------------------------------------------------
  doc.setFont("times", "bold")
  doc.setFontSize(20)
  setColor(NAVY)
  doc.text(company.name || "Company", margin, y + 6)
  y += 20

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  setColor(MUTED)
  const contactLine = [company.address, company.phone, company.email, company.website]
    .filter(Boolean)
    .join("   •   ")
  if (contactLine) {
    const lines = doc.splitTextToSize(contactLine, contentW)
    doc.text(lines, margin, y + 4)
    y += lines.length * 12
  }
  y += 8
  doc.setDrawColor(NAVY.r, NAVY.g, NAVY.b)
  doc.setLineWidth(1.2)
  doc.line(margin, y, pageW - margin, y)
  y += 26

  // --- Reference + date ---------------------------------------------------
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  setColor(MUTED)
  doc.text(`Ref: ${input.letterNumber || "—"}`, margin, y)
  const dateStr = `Date: ${fmtDate(input.issueDate) || fmtDate(new Date())}`
  doc.text(dateStr, pageW - margin - doc.getTextWidth(dateStr), y)
  y += 22

  // --- Recipient ----------------------------------------------------------
  if (input.recipientName) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    setColor(INK)
    doc.text(input.recipientName, margin, y)
    y += 15
    if (input.recipientMeta) {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9.5)
      setColor(MUTED)
      const metaLines = doc.splitTextToSize(input.recipientMeta, contentW)
      doc.text(metaLines, margin, y)
      y += metaLines.length * 12
    }
    y += 8
  }

  // --- Subject ------------------------------------------------------------
  if (input.subject) {
    doc.setFont("times", "bold")
    doc.setFontSize(12.5)
    setColor(INK)
    const subjectLines = doc.splitTextToSize(input.subject, contentW)
    doc.text(subjectLines, margin, y)
    y += subjectLines.length * 16 + 6
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.setLineWidth(0.6)
    doc.line(margin, y, pageW - margin, y)
    y += 20
  }

  // --- Body (paginated) ---------------------------------------------------
  doc.setFont("times", "normal")
  doc.setFontSize(11.5)
  setColor(INK)
  const lineH = 16.5

  const paragraphs = String(input.body || "").split(/\n{2,}/)
  const ensureSpace = (needed: number) => {
    if (y + needed > bottom) {
      doc.addPage()
      y = margin
    }
  }

  for (const para of paragraphs) {
    const trimmed = para.replace(/\n/g, " ").trim()
    if (!trimmed) {
      y += lineH * 0.6
      continue
    }
    const lines = doc.splitTextToSize(trimmed, contentW)
    for (const line of lines) {
      ensureSpace(lineH)
      doc.text(line, margin, y)
      y += lineH
    }
    y += lineH * 0.5
  }

  // --- Signature block ----------------------------------------------------
  const sig = input.signatory || {}
  const sigLabel = sig.label || `For ${company.name || "the Company"}`
  ensureSpace(90)
  y += 24
  doc.setFont("times", "normal")
  doc.setFontSize(11)
  setColor(INK)
  doc.text(sigLabel, margin, y)
  y += 40
  doc.setDrawColor(RULE.r, RULE.g, RULE.b)
  doc.setLineWidth(0.8)
  doc.line(margin, y, margin + 200, y)
  y += 15
  if (sig.name) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10.5)
    doc.text(sig.name, margin, y)
    y += 13
  }
  if (sig.designation) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    setColor(MUTED)
    doc.text(sig.designation, margin, y)
  }

  // --- Footer on every page ----------------------------------------------
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    setColor(MUTED)
    const footer = `${company.name || ""}${company.name ? "  •  " : ""}${input.letterNumber || ""}`
    doc.text(footer.trim(), margin, pageH - 28)
    const pageLabel = `Page ${i} of ${pageCount}`
    doc.text(pageLabel, pageW - margin - doc.getTextWidth(pageLabel), pageH - 28)
  }

  return doc
}

/** Convenience: return the letter as a Node Buffer for API responses / storage. */
export function letterPdfBuffer(input: LetterPdfInput): Buffer {
  const doc = buildLetterPdf(input)
  return Buffer.from(doc.output("arraybuffer"))
}
