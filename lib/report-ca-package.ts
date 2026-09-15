/**
 * CA Report Package — the combined, multi-report PDF engine (Phases 58–60).
 *
 * A Chartered Accountant typically wants a single bound document containing the
 * whole statutory set — Trial Balance, P&L, Balance Sheet, Cash Flow, day book,
 * ledgers, debtors/creditors, bank reconciliation, GST, TDS, audit exceptions,
 * fixed assets and year-end reports — rather than a dozen separate files. This
 * builder stitches any selection of already-run reports into ONE PDF with:
 *
 *   • a cover page (company name, package title, period, generated stamp),
 *   • a company-details page (address, GSTIN, PAN, contact),
 *   • a report index with the page number each report starts on,
 *   • every individual report rendered through the shared Tally-style model,
 *   • continuous "Page X of Y" footers across the whole document.
 *
 * It reuses lib/report-tally for grouping / subtotal / formatting so a report
 * inside the package looks identical to the same report exported on its own.
 * jspdf + jspdf-autotable are imported lazily so they never inflate the bundle.
 */

import {
  buildReportModel,
  cellExportText,
  formatIndianDateTime,
  reportFileStem,
  type ReportColumn,
  type ReportCompany,
  type ReportRow,
} from "@/lib/report-tally"

export type CaPackageReport = {
  key: string
  label: string
  group: string
  description?: string
  columns: ReportColumn[]
  rows: ReportRow[]
}

export type CaPackagePayload = {
  company: ReportCompany | null
  /** Package title, e.g. "CA Report Package". */
  title: string
  /** Period label shown on the cover + each report, e.g. "FY 2026-27". */
  periodLabel: string
  /** Financial-year label for the footer, e.g. "FY 2026-27". */
  financialYear: string
  generatedAt: string
  generatedBy: string
  reports: CaPackageReport[]
}

/**
 * Default statutory report set for the one-click CA package, mapped to the
 * catalogue keys that actually exist. The UI seeds its selection with these but
 * lets the user add or drop any report from the accessible catalogue.
 */
export const CA_PACKAGE_DEFAULT_KEYS: string[] = [
  "fs-trial-balance",
  "fs-profit-loss",
  "fs-balance-sheet",
  "fs-cash-flow",
  "ab-day-book",
  "ab-account-ledger",
  "ar-customer-outstanding",
  "ap-vendor-outstanding",
  "bc-bank-recon",
  "gst-gstr3b",
  "tds-return-summary",
  "au-exceptions",
  "ca-fixed-assets",
  "ye-closing-register",
]

const INK = [17, 24, 39] as const
const MUTED = [107, 114, 128] as const
const HEAD_BG = [31, 41, 55] as const
const GROUP_BG = [229, 231, 235] as const
const SUBTOTAL_BG = [243, 244, 246] as const
const TOTAL_BG = [219, 223, 230] as const
const ACCENT = [37, 99, 235] as const

const MARGIN_X = 12
const REPORT_TOP = 30

// Index capacities: the first index page carries a heading so it fits fewer
// rows than continuation pages. Kept deterministic so the page count can be
// computed before the reports are laid out.
const INDEX_FIRST_CAP = 24
const INDEX_REST_CAP = 34

function indexSlices(n: number): Array<[number, number]> {
  if (n === 0) return [[0, 0]]
  const slices: Array<[number, number]> = []
  let i = 0
  while (i < n) {
    const cap = slices.length === 0 ? INDEX_FIRST_CAP : INDEX_REST_CAP
    slices.push([i, Math.min(n, i + cap)])
    i += cap
  }
  return slices
}

function halignFor(c: ReportColumn): "left" | "right" {
  return c.align === "right" || c.money ? "right" : "left"
}

/** Draw the compact per-report letterhead repeated on every page of a report. */
function drawReportHeader(doc: any, company: ReportCompany | null, report: CaPackageReport, periodLabel: string) {
  const pageWidth = doc.internal.pageSize.getWidth()
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(...INK)
  doc.text(company?.name || "Company", MARGIN_X, 12)

  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text(report.label, pageWidth - MARGIN_X, 12, { align: "right" })

  const band = [periodLabel, "Amounts in INR"].filter(Boolean).join("   •   ")
  doc.setFont("helvetica", "normal")
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text(band, MARGIN_X, 17)

  doc.setDrawColor(...INK)
  doc.setLineWidth(0.4)
  doc.line(MARGIN_X, 19.5, pageWidth - MARGIN_X, 19.5)
}

/** Render one report's table onto the current (already-added) page. */
async function renderReportTable(
  doc: any,
  autoTable: any,
  report: CaPackageReport,
  payload: CaPackagePayload,
) {
  const { columns, rows } = report
  const pageWidth = doc.internal.pageSize.getWidth()

  drawReportHeader(doc, payload.company, report, payload.periodLabel)

  if (rows.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text("No records for the selected period.", pageWidth / 2, REPORT_TOP + 8, { align: "center" })
    return
  }

  const model = buildReportModel(columns, rows)
  const columnStyles: Record<number, any> = {}
  columns.forEach((c, i) => {
    if (c.align === "right" || c.money) columnStyles[i] = { halign: "right" }
  })

  const rowCells = (row: ReportRow, opts?: { blankGroupCol?: boolean }) =>
    columns.map((c) => {
      if (opts?.blankGroupCol && c.key === model.groupKey) return ""
      return cellExportText(row[c.key], c)
    })

  const body: any[] = []
  if (model.sections) {
    for (const section of model.sections) {
      body.push([
        {
          content: section.group,
          colSpan: columns.length,
          styles: { fontStyle: "bold", fillColor: [...GROUP_BG], textColor: [...INK], halign: "left" },
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
            styles: { fontStyle: "bold", fillColor: [...SUBTOTAL_BG], halign: halignFor(c) },
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

  autoTable(doc, {
    startY: REPORT_TOP,
    margin: { top: REPORT_TOP, left: MARGIN_X, right: MARGIN_X, bottom: 14 },
    head: [columns.map((c) => c.label)],
    body,
    foot,
    styles: { fontSize: 7, cellPadding: 1.4, textColor: [...INK], lineColor: [...MUTED], lineWidth: 0.1, overflow: "linebreak" },
    headStyles: { fillColor: [...HEAD_BG], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [...TOTAL_BG], textColor: [...INK], fontStyle: "bold" },
    columnStyles,
    showHead: "everyPage",
    // The letterhead is redrawn on every page of a multi-page report.
    didDrawPage: () => drawReportHeader(doc, payload.company, report, payload.periodLabel),
  })
}

function drawCover(doc: any, payload: CaPackagePayload) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const cx = pageWidth / 2

  doc.setDrawColor(...ACCENT)
  doc.setLineWidth(1.2)
  doc.line(MARGIN_X, 46, pageWidth - MARGIN_X, 46)

  doc.setFont("helvetica", "bold")
  doc.setFontSize(24)
  doc.setTextColor(...INK)
  doc.text(payload.company?.name || "Company", cx, 70, { align: "center", maxWidth: pageWidth - 2 * MARGIN_X })

  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.setTextColor(...ACCENT)
  doc.text(payload.title, cx, 86, { align: "center" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(11)
  doc.setTextColor(...MUTED)
  if (payload.periodLabel) doc.text(payload.periodLabel, cx, 98, { align: "center" })

  doc.setDrawColor(...ACCENT)
  doc.setLineWidth(1.2)
  doc.line(MARGIN_X, 108, pageWidth - MARGIN_X, 108)

  // Summary block, centred lower on the page.
  const lines = [
    `${payload.reports.length} report${payload.reports.length === 1 ? "" : "s"} included`,
    payload.financialYear ? payload.financialYear : "",
    payload.generatedAt ? `Generated ${formatIndianDateTime(payload.generatedAt)}` : "",
    payload.generatedBy ? `By ${payload.generatedBy}` : "",
  ].filter(Boolean)
  doc.setFontSize(10)
  doc.setTextColor(...INK)
  let y = pageHeight / 2 + 18
  for (const line of lines) {
    doc.text(line, cx, y, { align: "center" })
    y += 6.5
  }

  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text("Computer-generated report package — figures reflect posted transactions.", cx, pageHeight - 18, {
    align: "center",
  })
}

function drawCompanyDetails(doc: any, payload: CaPackagePayload) {
  const c = payload.company
  doc.setFont("helvetica", "bold")
  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text("Company Details", MARGIN_X, 24)

  doc.setDrawColor(...MUTED)
  doc.setLineWidth(0.3)
  doc.line(MARGIN_X, 27, doc.internal.pageSize.getWidth() - MARGIN_X, 27)

  const pairs: Array<[string, string]> = []
  pairs.push(["Name", c?.name || "—"])
  if (c?.addressLines?.length) pairs.push(["Address", c.addressLines.filter(Boolean).join(", ")])
  if (c?.taxNumber) pairs.push([c.taxLabel || "GSTIN", c.taxNumber])
  if (c?.pan) pairs.push(["PAN", c.pan])
  if (c?.email) pairs.push(["Email", c.email])
  if (c?.phone) pairs.push(["Phone", c.phone])
  if (c?.website) pairs.push(["Website", c.website])
  pairs.push(["Period", payload.periodLabel || "All time"])

  let y = 38
  for (const [label, value] of pairs) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9.5)
    doc.setTextColor(...MUTED)
    doc.text(label.toUpperCase(), MARGIN_X, y)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10.5)
    doc.setTextColor(...INK)
    doc.text(value, MARGIN_X + 40, y, { maxWidth: doc.internal.pageSize.getWidth() - MARGIN_X - 40 - MARGIN_X })
    y += 9
  }
}

function drawIndex(
  doc: any,
  firstIndexPage: number,
  slices: Array<[number, number]>,
  payload: CaPackagePayload,
  reportStartPages: number[],
) {
  const pageWidth = doc.internal.pageSize.getWidth()
  slices.forEach(([start, end], sliceIdx) => {
    doc.setPage(firstIndexPage + sliceIdx)
    let y: number
    if (sliceIdx === 0) {
      doc.setFont("helvetica", "bold")
      doc.setFontSize(14)
      doc.setTextColor(...INK)
      doc.text("Report Index", MARGIN_X, 24)
      doc.setDrawColor(...MUTED)
      doc.setLineWidth(0.3)
      doc.line(MARGIN_X, 27, pageWidth - MARGIN_X, 27)
      y = 37
    } else {
      y = 20
    }

    for (let i = start; i < end; i++) {
      const report = payload.reports[i]
      const page = reportStartPages[i]
      doc.setFont("helvetica", "normal")
      doc.setFontSize(10)
      doc.setTextColor(...INK)
      const num = `${i + 1}.`
      doc.text(num, MARGIN_X, y)
      doc.text(report.label, MARGIN_X + 8, y)

      doc.setTextColor(...MUTED)
      doc.setFontSize(8.5)
      doc.text(report.group, MARGIN_X + 8, y + 4)

      doc.setTextColor(...INK)
      doc.setFontSize(10)
      doc.text(`Page ${page}`, pageWidth - MARGIN_X, y, { align: "right" })

      doc.setDrawColor(233, 236, 240)
      doc.setLineWidth(0.2)
      doc.line(MARGIN_X, y + 6, pageWidth - MARGIN_X, y + 6)
      y += 10.5
    }
  })
}

/** Stamp "Page X of Y" + company / package footer on every page. */
function stampFooters(doc: any, payload: CaPackagePayload) {
  const total = doc.internal.getNumberOfPages()
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  for (let p = 1; p <= total; p++) {
    doc.setPage(p)
    doc.setDrawColor(...MUTED)
    doc.setLineWidth(0.2)
    doc.line(MARGIN_X, pageHeight - 10, pageWidth - MARGIN_X, pageHeight - 10)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text(payload.company?.name || "Company", MARGIN_X, pageHeight - 6)
    doc.text(payload.title, pageWidth / 2, pageHeight - 6, { align: "center" })
    doc.text(`Page ${p} of ${total}`, pageWidth - MARGIN_X, pageHeight - 6, { align: "right" })
  }
}

async function buildPackageDoc(payload: CaPackagePayload) {
  const { jsPDF } = await import("jspdf")
  const autoTable = (await import("jspdf-autotable")).default

  const reports = payload.reports
  const slices = indexSlices(reports.length)
  const indexPageCount = slices.length

  // Layout: cover (1), company details (2), index (3..2+indexPageCount),
  // then each report on its own fresh page. Reports begin after the index.
  const firstIndexPage = 3
  const firstReportPage = firstIndexPage + indexPageCount

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  // Cover.
  drawCover(doc, payload)
  // Company details.
  doc.addPage()
  drawCompanyDetails(doc, payload)
  // Reserve the index pages up front so reports land on stable page numbers.
  for (let i = 0; i < indexPageCount; i++) doc.addPage()

  // Reports — record the page each one starts on for the index.
  const reportStartPages: number[] = []
  for (const report of reports) {
    doc.addPage()
    reportStartPages.push(doc.internal.getNumberOfPages())
    await renderReportTable(doc, autoTable, report, payload)
  }

  // Fill the reserved index pages now that start pages are known.
  drawIndex(doc, firstIndexPage, slices, payload, reportStartPages)
  void firstReportPage

  // Continuous footers last, once the total page count is final.
  stampFooters(doc, payload)

  return doc
}

export function caPackageFileName(payload: CaPackagePayload): string {
  const fy = payload.financialYear ? `-${reportFileStem(payload.financialYear)}` : ""
  return `ca-report-package${fy}.pdf`
}

/** Build and download the combined CA package PDF. */
export async function exportCaPackagePdf(payload: CaPackagePayload): Promise<void> {
  const doc = await buildPackageDoc(payload)
  doc.save(caPackageFileName(payload))
}

/** Build the combined CA package as a Blob (for emailing as an attachment). */
export async function buildCaPackagePdfBlob(payload: CaPackagePayload): Promise<Blob> {
  const doc = await buildPackageDoc(payload)
  return doc.output("blob")
}
