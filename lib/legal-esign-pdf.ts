import "server-only"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { query } from "@/lib/db"
import { contractPdfBuffer } from "@/lib/legal-contract-pdf"
import { getGeneratedContract, contractPdfContext } from "@/lib/legal-contracts-generate"
import { ensureEsignTables, storeEsignFile, getEsignFile } from "@/lib/legal-esign"
import type { EsignRequest, EsignSigner, EsignField } from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Legal E-sign — PDF generation & signature application (server-only).
//
// The ORIGINAL contract PDF is generated once from the existing contract engine
// and frozen (Phase 41 — never overwritten). Signatures are applied onto a COPY
// with pdf-lib, so unrelated content, formatting, tables, headers and footers
// are preserved byte-for-byte (Phase 40). The signed PDF is stored as a
// separate version (Phase 42).
// ---------------------------------------------------------------------------

/**
 * Build (and cache) the immutable base PDF for a request. For contract-backed
 * requests it renders from the existing contract engine; the bytes are then
 * frozen in the secure file store and referenced by base_file_id.
 */
export async function ensureBasePdf(request: EsignRequest): Promise<Buffer> {
  await ensureEsignTables()
  if (request.base_file_id) {
    const existing = await getEsignFile(request.base_file_id)
    if (existing) return existing.data
  }

  const buffer = await renderBasePdf(request)
  const fileId = await storeEsignFile({
    kind: "pdf",
    data: buffer,
    contentType: "application/pdf",
    filename: `${request.request_uid}-original.pdf`,
    createdBy: request.created_by ?? undefined,
  })
  await query(`UPDATE legal_esign_requests SET base_file_id = ? WHERE id = ?`, [fileId, request.id])
  request.base_file_id = fileId
  return buffer
}

async function renderBasePdf(request: EsignRequest): Promise<Buffer> {
  if (request.contract_id) {
    const contract = await getGeneratedContract(request.contract_id)
    if (contract) {
      const ctx = await contractPdfContext(contract)
      return contractPdfBuffer({
        contractUid: contract.contract_uid,
        referenceNo: contract.reference_no,
        title: contract.title,
        contractType: contract.contract_type,
        body: contract.content,
        effectiveDate: ctx.effectiveDate,
        company: ctx.company,
        firstParty: ctx.firstParty,
        secondParty: ctx.secondParty,
      })
    }
  }
  // Fallback: a minimal document shell so manual/other-source requests still
  // have something to sign.
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89]) // A4 pt
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  page.drawText(request.title || "Document", { x: 56, y: 780, size: 18, font: bold, color: rgb(0.11, 0.16, 0.25) })
  page.drawText(`Reference: ${request.request_uid}`, { x: 56, y: 758, size: 10, font, color: rgb(0.4, 0.45, 0.5) })
  const msg = request.message || "This document is prepared for electronic signature."
  wrapText(msg, 90).forEach((line, i) => {
    page.drawText(line, { x: 56, y: 720 - i * 16, size: 11, font, color: rgb(0.15, 0.18, 0.22) })
  })
  const bytes = await pdf.save()
  return Buffer.from(bytes)
}

function wrapText(text: string, maxChars: number): string[] {
  const words = String(text).split(/\s+/)
  const lines: string[] = []
  let line = ""
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line.trim())
      line = w
    } else {
      line = (line + " " + w).trim()
    }
  }
  if (line) lines.push(line.trim())
  return lines.slice(0, 40)
}

function fmtNow(): { date: string; time: string } {
  const d = new Date()
  return {
    date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  }
}

/**
 * Apply every SIGNED signer's fields onto a copy of the base PDF and return the
 * resulting bytes. Idempotent: re-running with the same inputs reproduces the
 * same document. Only signers with status "Signed" are stamped, so a
 * partially-signed request carries exactly the marks collected so far
 * (Phase 43 — no signature is ever lost).
 */
export async function renderSignedPdf(
  request: EsignRequest,
  signers: EsignSigner[],
): Promise<Buffer> {
  const baseBytes = await ensureBasePdf(request)
  const pdf = await PDFDocument.load(baseBytes)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages = pdf.getPages()

  for (const signer of signers) {
    if (signer.status !== "Signed") continue
    const fields = (signer.fields || []) as EsignField[]
    const signedAt = signer.signed_at ? new Date(signer.signed_at) : new Date()
    const stamp = {
      date: signedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
      time: signedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    }

    // Pre-embed the signature image once per signer if present.
    let sigImage: any = null
    if (signer.signature_file_id) {
      const file = await getEsignFile(signer.signature_file_id)
      if (file) {
        try {
          sigImage =
            file.content_type?.includes("jpeg") || file.content_type?.includes("jpg")
              ? await pdf.embedJpg(file.data)
              : await pdf.embedPng(file.data)
        } catch {
          sigImage = null
        }
      }
    }

    for (const field of fields) {
      const pageIndex = Math.max(0, Math.min(pages.length - 1, (field.page || 1) - 1))
      const page = pages[pageIndex]
      const pw = page.getWidth()
      const ph = page.getHeight()
      // Stored coordinates are top-left fractions; pdf-lib origin is bottom-left.
      const x = field.pos_x * pw
      const boxW = field.width * pw
      const boxH = field.height * ph
      const yTop = field.pos_y * ph
      const y = ph - yTop - boxH

      if (field.field_type === "signature") {
        if (sigImage) {
          const scale = Math.min(boxW / sigImage.width, boxH / sigImage.height)
          const w = sigImage.width * scale
          const h = sigImage.height * scale
          page.drawImage(sigImage, { x, y: y + (boxH - h) / 2, width: w, height: h })
        } else {
          page.drawText(signer.name, { x, y: y + boxH / 2, size: 12, font: bold, color: rgb(0.11, 0.16, 0.25) })
        }
        // Signer caption under the signature.
        page.drawText(`${signer.name}${signer.role ? " · " + signer.role : ""}`, {
          x,
          y: y - 10,
          size: 7,
          font,
          color: rgb(0.35, 0.4, 0.45),
        })
        page.drawText(`Signed ${stamp.date} ${stamp.time}`, {
          x,
          y: y - 19,
          size: 6.5,
          font,
          color: rgb(0.45, 0.5, 0.55),
        })
      } else {
        let text = field.value || ""
        if (field.field_type === "date") text = stamp.date
        else if (field.field_type === "name") text = signer.name
        else if (field.field_type === "designation") text = signer.role || ""
        if (text) {
          page.drawText(text, { x, y: y + boxH / 2 - 4, size: 10, font, color: rgb(0.11, 0.16, 0.25) })
        }
      }
    }
  }

  // Certificate footer stamp on the last page (Phase 39 — document id + status).
  const last = pages[pages.length - 1]
  const now = fmtNow()
  last.drawText(
    `E-sign Request ${request.request_uid} · Generated ${now.date} ${now.time}`,
    { x: 56, y: 24, size: 7, font, color: rgb(0.55, 0.58, 0.62) },
  )

  const bytes = await pdf.save()
  return Buffer.from(bytes)
}

/**
 * Generate the signed PDF for the CURRENT signature state and store it as the
 * request's signed document version. Returns the stored file id.
 */
export async function storeSignedPdf(
  request: EsignRequest,
  signers: EsignSigner[],
  opts: { final?: boolean; actorId?: number | null } = {},
): Promise<string> {
  const buffer = await renderSignedPdf(request, signers)
  const fileId = await storeEsignFile({
    kind: "pdf",
    data: buffer,
    contentType: "application/pdf",
    filename: `${request.request_uid}-signed${opts.final ? "-final" : ""}.pdf`,
    createdBy: opts.actorId ?? undefined,
  })
  await query(`UPDATE legal_esign_requests SET signed_file_id = ? WHERE id = ?`, [fileId, request.id])
  request.signed_file_id = fileId
  return fileId
}
