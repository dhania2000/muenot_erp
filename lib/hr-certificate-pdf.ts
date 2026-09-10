import "server-only"
import { jsPDF } from "jspdf"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type CertificateCompany = {
  name: string
  email?: string
  phone?: string
  addressLines?: string[]
}

export type CertificateData = {
  /** Award = "Certificate of Excellence", Appreciation = "Certificate of Appreciation". */
  kind: "award" | "appreciation"
  recipientName: string
  recipientRole?: string
  /** Award name or appreciation title. */
  title: string
  /** Award description or appreciation message. */
  description?: string
  date?: string
  givenBy?: string
  category?: string
  refNumber?: string
  company: CertificateCompany
}

// ---------------------------------------------------------------------------
// Palette (RGB tuples) — deep navy + gold, printed on cream.
// ---------------------------------------------------------------------------
const NAVY: [number, number, number] = [30, 58, 95] // #1e3a5f
const GOLD: [number, number, number] = [176, 137, 43] // #b0892b
const INK: [number, number, number] = [31, 41, 55] // #1f2937
const MUTED: [number, number, number] = [107, 114, 128] // #6b7280
const CREAM: [number, number, number] = [253, 251, 246] // #fdfbf6

function fmtDate(v: any): string {
  if (!v) return ""
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

// ---------------------------------------------------------------------------
// Builder — landscape A4 certificate.
// ---------------------------------------------------------------------------
export function buildCertificatePdf(data: CertificateData): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" })
  const W = doc.internal.pageSize.getWidth() // ~842
  const H = doc.internal.pageSize.getHeight() // ~595
  const cx = W / 2

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2])
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])

  const isAward = data.kind === "award"

  // --- Cream background ---
  setFill(CREAM)
  doc.rect(0, 0, W, H, "F")

  // --- Decorative borders (thick navy outer + thin gold inner) ---
  setDraw(NAVY)
  doc.setLineWidth(3)
  doc.rect(22, 22, W - 44, H - 44)
  setDraw(GOLD)
  doc.setLineWidth(1)
  doc.rect(32, 32, W - 64, H - 64)

  // Corner accents — small gold diamonds inside each corner.
  const diamond = (x: number, y: number, r: number) => {
    setFill(GOLD)
    doc.triangle(x, y - r, x + r, y, x, y + r, "F")
    doc.triangle(x, y - r, x - r, y, x, y + r, "F")
  }
  for (const [x, y] of [
    [46, 46],
    [W - 46, 46],
    [46, H - 46],
    [W - 46, H - 46],
  ] as const) {
    diamond(x, y, 6)
  }

  // --- Header: company name + contact line ---
  let y = 78
  setColor(NAVY)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.setCharSpace(1.5)
  doc.text((data.company.name || "Company").toUpperCase(), cx, y, { align: "center" })
  doc.setCharSpace(0)

  const contactBits = [
    ...(data.company.addressLines || []).filter(Boolean),
    [data.company.email, data.company.phone].filter(Boolean).join("  •  "),
  ].filter(Boolean)
  if (contactBits.length) {
    y += 14
    setColor(MUTED)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.text(contactBits.join("  •  "), cx, y, { align: "center" })
  }

  // Thin gold rule under the header.
  y += 16
  setDraw(GOLD)
  doc.setLineWidth(0.8)
  doc.line(cx - 120, y, cx + 120, y)

  // --- Certificate title ---
  y += 52
  setColor(NAVY)
  doc.setFont("times", "bold")
  doc.setFontSize(38)
  doc.setCharSpace(1)
  doc.text(isAward ? "Certificate of Excellence" : "Certificate of Appreciation", cx, y, { align: "center" })
  doc.setCharSpace(0)

  // --- Presented-to line ---
  y += 34
  setColor(MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(11)
  doc.text("This certificate is proudly presented to", cx, y, { align: "center" })

  // --- Recipient name ---
  y += 44
  setColor(INK)
  doc.setFont("times", "bolditalic")
  doc.setFontSize(34)
  doc.text(data.recipientName || "Recipient", cx, y, { align: "center" })

  // Underline sized to the name.
  const nameWidth = Math.min(
    W - 180,
    Math.max(220, doc.getTextWidth(data.recipientName || "Recipient") + 60),
  )
  y += 10
  setDraw(GOLD)
  doc.setLineWidth(0.8)
  doc.line(cx - nameWidth / 2, y, cx + nameWidth / 2, y)

  if (data.recipientRole) {
    y += 16
    setColor(MUTED)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.text(data.recipientRole, cx, y, { align: "center" })
  }

  // --- Citation body ---
  y += 34
  setColor(INK)
  doc.setFont("times", "normal")
  doc.setFontSize(13)

  const lead = isAward
    ? `in recognition of the ${data.title}`
    : `in appreciation of ${data.title}`
  const citation = [lead, data.description?.trim()].filter(Boolean).join(". ")
  const bodyLines = doc.splitTextToSize(citation, W - 240) as string[]
  doc.text(bodyLines.slice(0, 4), cx, y, { align: "center", lineHeightFactor: 1.5 })

  // --- Footer: date (left) + authorised signatory (right) ---
  const footY = H - 80
  const leftX = 120
  const rightX = W - 120

  setDraw(INK)
  doc.setLineWidth(0.7)
  doc.line(leftX - 60, footY, leftX + 60, footY)
  doc.line(rightX - 70, footY, rightX + 70, footY)

  setColor(INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text(fmtDate(data.date) || "—", leftX, footY - 6, { align: "center" })
  doc.text(data.givenBy || data.company.name || "—", rightX, footY - 6, { align: "center" })

  setColor(MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8.5)
  doc.text("Date", leftX, footY + 14, { align: "center" })
  doc.text("Authorised Signatory", rightX, footY + 14, { align: "center" })

  // Ref number at very bottom center.
  if (data.refNumber) {
    setColor(MUTED)
    doc.setFontSize(8)
    doc.text(`Ref: ${data.refNumber}`, cx, H - 42, { align: "center" })
  }

  return Buffer.from(doc.output("arraybuffer"))
}
