// ---------------------------------------------------------------------------
// Legal Contracts — contract document PDF builder (jsPDF).
//
// Renders a rendered contract body (HTML from the rich editor, or plain text)
// into a formal A4 agreement: title block, reference/date row, paginated body
// with basic block formatting (headings, paragraphs, list items), and a
// two-party signature block. Sibling of lib/hr-letter-pdf.ts.
// ---------------------------------------------------------------------------

import { jsPDF } from "jspdf"

export type ContractParty = {
  role?: string | null
  name?: string | null
  meta?: string | null
}

export type ContractPdfInput = {
  contractUid: string
  referenceNo?: string | null
  title: string
  contractType?: string | null
  body: string
  effectiveDate?: string | Date | null
  company: { name?: string; address?: string; email?: string; phone?: string; website?: string }
  firstParty?: ContractParty
  secondParty?: ContractParty
}

const INK = { r: 17, g: 24, b: 39 }
const MUTED = { r: 100, g: 116, b: 139 }
const RULE = { r: 203, g: 213, b: 225 }
const NAVY = { r: 30, g: 58, b: 95 }

function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return ""
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

// --- Lightweight HTML -> structured blocks ----------------------------------
type Block = { type: "h1" | "h2" | "p" | "li"; text: string }

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
}

function stripInline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

/** Parse the body into ordered blocks. Falls back to paragraph splitting for
 *  plain-text bodies that contain no HTML tags. */
function parseBlocks(body: string): Block[] {
  const text = String(body || "")
  const blocks: Block[] = []
  if (!/<[a-z][\s\S]*>/i.test(text)) {
    for (const para of text.split(/\n{2,}/)) {
      const t = para.replace(/\n/g, " ").trim()
      if (t) blocks.push({ type: "p", text: t })
    }
    return blocks
  }

  const blockRe = /<(h1|h2|h3|h4|li|p|div)[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  let matchedAny = false
  while ((m = blockRe.exec(text))) {
    matchedAny = true
    const tag = m[1].toLowerCase()
    const inner = stripInline(m[2])
    if (!inner) continue
    if (tag === "h1") blocks.push({ type: "h1", text: inner })
    else if (tag === "h2" || tag === "h3" || tag === "h4") blocks.push({ type: "h2", text: inner })
    else if (tag === "li") blocks.push({ type: "li", text: inner })
    else blocks.push({ type: "p", text: inner })
  }
  if (!matchedAny) {
    const flat = stripInline(text)
    if (flat) blocks.push({ type: "p", text: flat })
  }
  return blocks
}

export function buildContractPdf(input: ContractPdfInput): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 56
  const contentW = pageW - margin * 2
  const bottom = pageH - margin - 40
  let y = margin

  const company = input.company || {}
  const setColor = (c: { r: number; g: number; b: number }) => doc.setTextColor(c.r, c.g, c.b)
  const ensureSpace = (needed: number) => {
    if (y + needed > bottom) {
      doc.addPage()
      y = margin
    }
  }

  // --- Header -------------------------------------------------------------
  doc.setFont("times", "bold")
  doc.setFontSize(16)
  setColor(NAVY)
  doc.text(company.name || "Company", margin, y + 4)
  y += 16
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  setColor(MUTED)
  const contactLine = [company.address, company.phone, company.email, company.website].filter(Boolean).join("   •   ")
  if (contactLine) {
    const lines = doc.splitTextToSize(contactLine, contentW)
    doc.text(lines, margin, y + 2)
    y += lines.length * 11
  }
  y += 8
  doc.setDrawColor(NAVY.r, NAVY.g, NAVY.b)
  doc.setLineWidth(1.2)
  doc.line(margin, y, pageW - margin, y)
  y += 24

  // --- Title --------------------------------------------------------------
  doc.setFont("times", "bold")
  doc.setFontSize(16)
  setColor(INK)
  const titleLines = doc.splitTextToSize((input.title || "Agreement").toUpperCase(), contentW)
  for (const line of titleLines) {
    doc.text(line, pageW / 2, y, { align: "center" })
    y += 20
  }
  y += 4

  // --- Reference + date ---------------------------------------------------
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9.5)
  setColor(MUTED)
  doc.text(`Ref: ${input.referenceNo || input.contractUid || "—"}`, margin, y)
  const dateStr = `Effective: ${fmtDate(input.effectiveDate) || fmtDate(new Date())}`
  doc.text(dateStr, pageW - margin - doc.getTextWidth(dateStr), y)
  y += 12
  doc.setDrawColor(RULE.r, RULE.g, RULE.b)
  doc.setLineWidth(0.6)
  doc.line(margin, y, pageW - margin, y)
  y += 22

  // --- Body ---------------------------------------------------------------
  const blocks = parseBlocks(input.body)
  const lineH = 15.5
  for (const block of blocks) {
    if (block.type === "h1" || block.type === "h2") {
      const size = block.type === "h1" ? 13 : 11.5
      doc.setFont("times", "bold")
      doc.setFontSize(size)
      setColor(INK)
      const lines = doc.splitTextToSize(block.text, contentW)
      ensureSpace(lines.length * (size + 4) + 6)
      y += 6
      for (const line of lines) {
        doc.text(line, margin, y)
        y += size + 4
      }
      y += 4
      continue
    }
    doc.setFont("times", "normal")
    doc.setFontSize(11)
    setColor(INK)
    const indent = block.type === "li" ? 18 : 0
    const bullet = block.type === "li" ? "•  " : ""
    const lines = doc.splitTextToSize((bullet ? "" : "") + block.text, contentW - indent)
    for (let i = 0; i < lines.length; i++) {
      ensureSpace(lineH)
      if (i === 0 && bullet) {
        doc.text("•", margin, y)
        doc.text(lines[i], margin + indent, y)
      } else {
        doc.text(lines[i], margin + indent, y)
      }
      y += lineH
    }
    y += lineH * 0.4
  }

  // --- Signature blocks (two parties, side by side) -----------------------
  const first = input.firstParty || { role: "For the Company", name: company.name }
  const second = input.secondParty || { role: "Counterparty" }
  ensureSpace(120)
  y += 30

  const colGap = 40
  const colW = (contentW - colGap) / 2
  const leftX = margin
  const rightX = margin + colW + colGap
  const sigTop = y

  const drawSig = (x: number, party: ContractParty) => {
    let sy = sigTop
    doc.setFont("times", "normal")
    doc.setFontSize(10)
    setColor(INK)
    doc.text(party.role || "Party", x, sy)
    sy += 44
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.setLineWidth(0.8)
    doc.line(x, sy, x + colW - 20, sy)
    sy += 14
    if (party.name) {
      doc.setFont("helvetica", "bold")
      doc.setFontSize(10)
      setColor(INK)
      doc.text(String(party.name), x, sy)
      sy += 12
    }
    if (party.meta) {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9)
      setColor(MUTED)
      const metaLines = doc.splitTextToSize(String(party.meta), colW - 20)
      doc.text(metaLines, x, sy)
    }
  }

  drawSig(leftX, first)
  drawSig(rightX, second)

  // --- Footer -------------------------------------------------------------
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    setColor(MUTED)
    const footer = `${company.name || ""}${company.name ? "  •  " : ""}${input.contractUid || ""}`
    doc.text(footer.trim(), margin, pageH - 28)
    const pageLabel = `Page ${i} of ${pageCount}`
    doc.text(pageLabel, pageW - margin - doc.getTextWidth(pageLabel), pageH - 28)
  }

  return doc
}

export function contractPdfBuffer(input: ContractPdfInput): Buffer {
  const doc = buildContractPdf(input)
  return Buffer.from(doc.output("arraybuffer"))
}
