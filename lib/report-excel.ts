/**
 * Centralised CSV + Excel exporters for the Financial Reports module.
 *
 * They share the exact same grouping / subtotal / grand-total model as the PDF
 * engine (via `buildReportModel`) so all three formats agree line-for-line.
 * `xlsx` is imported lazily to keep it out of the initial client bundle.
 *
 * Money cells are written as real numbers (rounded to 2 decimals) so the values
 * stay analysable inside a spreadsheet; the Indian string formatting is a
 * presentation concern reserved for the PDF and on-screen views.
 */

import {
  buildReportModel,
  generatedStamp,
  reportFileStem,
  type ReportColumn,
  type ReportExportPayload,
  type ReportRow,
} from "@/lib/report-tally"

// --- CSV ---------------------------------------------------------------------

function csvEscape(value: any): string {
  const s = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function csvCell(value: any, col: ReportColumn): string {
  if (value === null || value === undefined || value === "") return ""
  if (col.money) return String(Math.round((Number(value) + Number.EPSILON) * 100) / 100)
  return String(value)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function exportReportCsv(payload: ReportExportPayload): void {
  const { columns, rows, subtitle } = payload
  const model = buildReportModel(columns, rows)
  const lines: string[] = []

  if (subtitle) lines.push(csvEscape(subtitle))
  lines.push(columns.map((c) => csvEscape(c.label)).join(","))

  const rowLine = (row: ReportRow, blankGroupCol = false) =>
    columns
      .map((c) => csvEscape(blankGroupCol && c.key === model.groupKey ? "" : csvCell(row[c.key], c)))
      .join(",")

  if (model.sections) {
    for (const section of model.sections) {
      lines.push(csvEscape(section.group))
      for (const r of section.rows) lines.push(rowLine(r, true))
      if (model.moneyCols.length > 0) {
        lines.push(
          columns
            .map((c, i) =>
              csvEscape(
                i === 0
                  ? `Subtotal — ${section.group}`
                  : section.subtotals[c.key] !== undefined
                    ? csvCell(section.subtotals[c.key], c)
                    : "",
              ),
            )
            .join(","),
        )
      }
    }
  } else {
    for (const r of rows) lines.push(rowLine(r))
  }

  if (model.grandTotals) {
    lines.push(
      columns
        .map((c, i) =>
          csvEscape(
            i === 0
              ? "Total"
              : model.grandTotals![c.key] !== undefined
                ? csvCell(model.grandTotals![c.key], c)
                : "",
          ),
        )
        .join(","),
    )
  }

  triggerDownload(
    new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }),
    `${reportFileStem(payload.reportKey)}.csv`,
  )
}

// --- Excel -------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

function excelCell(value: any, col: ReportColumn): any {
  if (value === null || value === undefined || value === "") return ""
  if (col.money) return round2(Number(value) || 0)
  return value
}

export async function exportReportExcel(payload: ReportExportPayload): Promise<void> {
  const XLSX = await import("xlsx")
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
  } = payload
  const model = buildReportModel(columns, rows)

  const aoa: any[][] = []
  const colCount = columns.length
  const pad = (cells: any[]) => {
    const out = cells.slice(0, colCount)
    while (out.length < colCount) out.push("")
    return out
  }

  // Header block (letterhead + metadata) above the table.
  aoa.push(pad([company?.name || "Company"]))
  if (company?.taxNumber) aoa.push(pad([`${company.taxLabel || "Tax"}: ${company.taxNumber}`]))
  const contact = [company?.email, company?.phone, company?.website].filter(Boolean).join("  •  ")
  if (contact) aoa.push(pad([contact]))
  aoa.push(pad([reportLabel]))
  if (reportDescription) aoa.push(pad([reportDescription]))
  if (subtitle) aoa.push(pad([subtitle]))
  if (filterLabels && filterLabels.length > 0) aoa.push(pad([filterLabels.join("   •   ")]))
  const stamp = generatedStamp(generatedAt)
  const stampLine = [
    "Amounts in INR",
    stamp ? `Generated ${stamp}` : "",
    generatedBy ? `by ${generatedBy}` : "",
  ]
    .filter(Boolean)
    .join("   •   ")
  aoa.push(pad([stampLine]))
  aoa.push(pad([]))

  aoa.push(pad(columns.map((c) => c.label)))

  const rowCells = (row: ReportRow, blankGroupCol = false) =>
    columns.map((c) => (blankGroupCol && c.key === model.groupKey ? "" : excelCell(row[c.key], c)))

  if (model.sections) {
    for (const section of model.sections) {
      aoa.push(pad([section.group]))
      for (const r of section.rows) aoa.push(pad(rowCells(r, true)))
      if (model.moneyCols.length > 0) {
        aoa.push(
          pad(
            columns.map((c, i) =>
              i === 0
                ? `Subtotal — ${section.group}`
                : section.subtotals[c.key] !== undefined
                  ? round2(section.subtotals[c.key])
                  : "",
            ),
          ),
        )
      }
    }
  } else {
    for (const r of rows) aoa.push(pad(rowCells(r)))
  }

  if (model.grandTotals) {
    aoa.push(
      pad(
        columns.map((c, i) =>
          i === 0
            ? "Total"
            : model.grandTotals![c.key] !== undefined
              ? round2(model.grandTotals![c.key])
              : "",
        ),
      ),
    )
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Column widths: money columns get a comfortable numeric width.
  ws["!cols"] = columns.map((c) => ({ wch: c.money ? 16 : Math.max(14, c.label.length + 2) }))

  const wb = XLSX.utils.book_new()
  const sheetName = reportLabel.slice(0, 28).replace(/[\\/?*[\]:]/g, " ") || "Report"
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" })
  triggerDownload(
    new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${reportFileStem(payload.reportKey)}.xlsx`,
  )
}
