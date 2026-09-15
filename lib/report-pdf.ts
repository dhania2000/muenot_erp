/**
 * The single, reusable Tally-style PDF engine for the Financial Reports module.
 *
 * Every report — Balance Sheet, P&L, Trial Balance, ledgers, registers — is
 * rendered through this one function so the letterhead, period band, Dr/Cr
 * alignment, group subtotals, grand total and page footer are consistent
 * across the entire catalogue. jspdf + jspdf-autotable are imported lazily so
 * they never inflate the initial client bundle.
 */

import {
  buildReportModel,
  cellExportText,
  generatedStamp,
  reportFileStem,
  type ReportColumn,
  type ReportExportPayload,
} from "@/lib/report-tally"

// Ink colours (RGB) kept muted and print-friendly.
const INK = [17, 24, 39] as const
const MUTED = [107, 114, 128] as const
const HEAD_BG = [31, 41, 55] as const
const GROUP_BG = [229, 231, 235] as const
const SUBTOTAL_BG = [243, 244, 246] as const
const TOTAL_BG = [219, 223, 230] as const

/**
 * Build the report PDF document (without saving). Both the direct download
 * (`exportReportPdf`) and the email-attachment builder (`buildReportPdfBlob`)
 * share this so an emailed PDF is byte-for-byte the same snapshot a user would
 * have downloaded.
 */
async function buildReportPdfDoc(payload: ReportExportPayload) {
  const { jsPDF } = await import("jspdf")
  const autoTable = (await import("jspdf-autotable")).default

  const {
    reportLabel,
    reportDescription,
    columns,
    rows,
    company,
    subtitle,
    filterLabels,
    generatedAt,
    generatedBy,
    financialYear,
  } = payload

  const model = buildReportModel(columns, rows)
  const wide = columns.length > 6
  const doc = new jsPDF({ orientation: wide ? "landscape" : "portrait", unit: "mm", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const marginX = 12

  const halignFor = (c: ReportColumn): "left" | "right" =>
    c.align === "right" || c.money ? "right" : "left"

  // Column alignment: money / explicitly right-aligned columns hug the right.
  const columnStyles: Record<number, any> = {}
  columns.forEach((c, i) => {
    if (c.align === "right" || c.money) columnStyles[i] = { halign: "right" }
  })

  const body: any[] = []

  const rowCells = (row: Record<string, any>, opts?: { blankGroupCol?: boolean }) =>
    columns.map((c) => {
      if (opts?.blankGroupCol && c.key === model.groupKey) return ""
      return cellExportText(row[c.key], c)
    })

  if (model.sections) {
    for (const section of model.sections) {
      // Group heading row spanning the first cell (autotable renders it left).
      body.push([
        {
          content: section.group,
          colSpan: columns.length,
          styles: {
            fontStyle: "bold",
            fillColor: [...GROUP_BG],
            textColor: [...INK],
            halign: "left",
          },
        },
      ])
      for (const r of section.rows) body.push(rowCells(r, { blankGroupCol: true }))
      if (model.moneyCols.length > 0) {
        body.push(
          columns.map((c, i) => ({
            content:
              i === 0
                ? `Subtotal — ${section.group}`
                : section.subtotals[c.key] !== undefined
                  ? cellExportText(section.subtotals[c.key], c)
                  : "",
            styles: {
              fontStyle: "bold",
              fillColor: [...SUBTOTAL_BG],
              halign: halignFor(c),
            },
          })),
        )
      }
    }
  } else {
    for (const r of rows) body.push(rowCells(r))
  }

  const foot =
    model.grandTotals && rows.length > 0
      ? [
          columns.map((c, i) => ({
            content:
              i === 0
                ? "Total"
                : model.grandTotals![c.key] !== undefined
                  ? cellExportText(model.grandTotals![c.key], c)
                  : "",
            styles: { halign: halignFor(c) },
          })),
        ]
      : undefined

  const stamp = generatedStamp(generatedAt)
  const totalPagesExp = "{total_pages_count_string}"

  autoTable(doc, {
    // Reserve vertical space for the repeated letterhead drawn in didDrawPage.
    margin: { top: 42, left: marginX, right: marginX, bottom: 16 },
    head: [columns.map((c) => c.label)],
    body,
    foot,
    styles: { fontSize: 8, cellPadding: 1.8, textColor: [...INK], lineColor: [...MUTED], lineWidth: 0.1 },
    headStyles: { fillColor: [...HEAD_BG], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [...TOTAL_BG], textColor: [...INK], fontStyle: "bold" },
    columnStyles,
    // Repeat the head on every page; the group/subtotal styling is baked into
    // the body cells above.
    showHead: "everyPage",
    didDrawPage: (data) => {
      // --- Letterhead (repeated on every page) ---
      let y = 12
      doc.setFont("helvetica", "bold")
      doc.setFontSize(13)
      doc.setTextColor(...INK)
      doc.text(company?.name || "Company", marginX, y)

      // Registered address, one muted line each (Phase 42).
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...MUTED)
      for (const line of (company?.addressLines ?? []).filter(Boolean)) {
        y += 4
        doc.text(line, marginX, y)
      }

      // Statutory identity: GSTIN + PAN first, then contact details.
      const identity = [
        company?.taxNumber ? `${company.taxLabel || "GSTIN"}: ${company.taxNumber}` : "",
        company?.pan ? `PAN: ${company.pan}` : "",
      ]
        .filter(Boolean)
        .join("   •   ")
      if (identity) {
        y += 4
        doc.text(identity, marginX, y)
      }
      const contact = [company?.email, company?.phone, company?.website].filter(Boolean).join("   •   ")
      if (contact) {
        y += 4
        doc.text(contact, marginX, y)
      }

      // Report title (centred).
      y += 7
      doc.setFont("helvetica", "bold")
      doc.setFontSize(11)
      doc.setTextColor(...INK)
      doc.text(reportLabel, pageWidth / 2, y, { align: "center" })

      // Filter summary band — FY, period and any active dimension filters
      // (Phase 44). FY leads so a printed report is self-describing.
      const bandBits = [
        financialYear ? `FY: ${financialYear.replace(/^FY\s*/i, "")}` : "",
        subtitle,
        ...(filterLabels ?? []),
      ].filter(Boolean)
      if (bandBits.length > 0) {
        y += 4.5
        doc.setFont("helvetica", "normal")
        doc.setFontSize(8)
        doc.setTextColor(...MUTED)
        doc.text(bandBits.join("   •   "), pageWidth / 2, y, { align: "center" })
      }

      // "Amounts in INR" note (left).
      y += 4.5
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      doc.text("Amounts in INR", marginX, y)

      // Rule under the letterhead.
      doc.setDrawColor(...INK)
      doc.setLineWidth(0.4)
      doc.line(marginX, y + 2, pageWidth - marginX, y + 2)

      // --- Footer (Phase 43): generated-by + timestamp + FY on the left,
      // page X of Y on the right, description note above. ---
      const pageHeight = doc.internal.pageSize.getHeight()
      const pageNo = (doc as any).internal.getNumberOfPages()
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7)
      doc.setTextColor(...MUTED)

      // Footer rule.
      doc.setDrawColor(...MUTED)
      doc.setLineWidth(0.2)
      doc.line(marginX, pageHeight - 11, pageWidth - marginX, pageHeight - 11)

      const footLeft = [
        generatedBy ? `Generated by ${generatedBy}` : "Computer-generated report",
        stamp ? `on ${stamp}` : "",
        financialYear ? `• ${financialYear}` : "",
      ]
        .filter(Boolean)
        .join(" ")
      doc.text(footLeft, marginX, pageHeight - 7)
      doc.text(`Page ${pageNo} of ${totalPagesExp}`, pageWidth - marginX, pageHeight - 7, {
        align: "right",
      })
      if (reportDescription) {
        doc.text(reportDescription, pageWidth / 2, pageHeight - 7, { align: "center" })
      }
    },
  })

  // Backfill the total page count placeholder now that every page exists.
  if (typeof (doc as any).putTotalPages === "function") {
    ;(doc as any).putTotalPages(totalPagesExp)
  }

  return doc
}

/** A stable, human-friendly file name for a downloaded / attached report PDF. */
export function reportPdfFileName(payload: ReportExportPayload): string {
  return `${reportFileStem(payload.reportKey)}.pdf`
}

/** Generate the report PDF and trigger a browser download. */
export async function exportReportPdf(payload: ReportExportPayload): Promise<void> {
  const doc = await buildReportPdfDoc(payload)
  doc.save(reportPdfFileName(payload))
}

/**
 * Generate the identical report PDF as a Blob — used to attach the exact
 * snapshot to an outgoing report email (Phase 16 / 20) rather than rebuilding
 * a second, potentially-divergent document.
 */
export async function buildReportPdfBlob(payload: ReportExportPayload): Promise<Blob> {
  const doc = await buildReportPdfDoc(payload)
  return doc.output("blob")
}
