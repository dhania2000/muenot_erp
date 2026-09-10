import * as XLSX from "xlsx"

/**
 * A column definition for an Excel export. `header` is the human-readable
 * column title written to the first row; `value` extracts the cell content
 * from a single data row.
 */
export type ExportColumn<T> = {
  header: string
  value: (row: T) => unknown
}

function formatCell(value: unknown): string | number {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Prettifies a raw object key into a column header, e.g. "lead_code" -> "Lead Code". */
function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Exports an array of rows to a downloaded .xlsx file.
 *
 * When `columns` is provided, only those columns are exported in that order.
 * Otherwise the columns are inferred from the keys of the first row.
 */
export function exportRowsToExcel<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns?: ExportColumn<T>[],
): void {
  const safeName = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`

  const cols: ExportColumn<T>[] =
    columns && columns.length > 0
      ? columns
      : Object.keys(rows[0] ?? {}).map((key) => ({
          header: humanizeKey(key),
          value: (row: T) => (row as Record<string, unknown>)[key],
        }))

  const aoa: (string | number)[][] = [
    cols.map((c) => c.header),
    ...rows.map((row) => cols.map((c) => formatCell(c.value(row)))),
  ]

  const worksheet = XLSX.utils.aoa_to_sheet(aoa)

  // Size each column to the widest value so the sheet is readable on open.
  worksheet["!cols"] = cols.map((c, i) => {
    const widest = aoa.reduce((max, r) => {
      const cell = r[i]
      const len = cell === undefined || cell === null ? 0 : String(cell).length
      return Math.max(max, len)
    }, 10)
    return { wch: Math.min(widest + 2, 50) }
  })

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1")
  XLSX.writeFile(workbook, safeName)
}
