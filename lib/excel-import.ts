import * as XLSX from "xlsx"

/**
 * Normalizes a spreadsheet header into a comparable key:
 * lowercase, alphanumeric only. e.g. "Contact Number" -> "contactnumber"
 */
function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Reads an .xlsx/.xls/.csv File in the browser and returns each row as a
 * plain object keyed by the raw header text found in the first row.
 */
export async function readExcelFile(file: File): Promise<Record<string, string>[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) return []
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" })
  return rows.map((row) => {
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(row)) {
      clean[key] = value === null || value === undefined ? "" : String(value).trim()
    }
    return clean
  })
}

/**
 * Maps a raw spreadsheet row (arbitrary header casing/spacing) onto a set of
 * canonical field names using an alias table, e.g.:
 *   { company_name: ["companyname", "company"] }
 */
export function mapRow<T extends string>(
  row: Record<string, string>,
  aliases: Record<T, string[]>,
): Record<T, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeKey(key)] = value
  }

  const result = {} as Record<T, string>
  for (const field of Object.keys(aliases) as T[]) {
    const candidates = aliases[field]
    let value = ""
    for (const candidate of candidates) {
      if (normalized[candidate] !== undefined && normalized[candidate] !== "") {
        value = normalized[candidate]
        break
      }
    }
    result[field] = value
  }
  return result
}

/**
 * Parses a date cell coming from an uploaded spreadsheet into a MySQL-safe
 * "YYYY-MM-DD" string. Accepts values already in that format, common
 * Indian-style "DD/MM/YYYY" or "DD-MM-YYYY" text, and raw Excel serial date
 * numbers (which SheetJS returns when a cell is formatted as a date).
 * Returns null when the value is empty or cannot be parsed.
 */
export function parseSpreadsheetDate(value: string): string | null {
  const trimmed = (value || "").trim()
  if (!trimmed) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed

  const slashOrDash = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (slashOrDash) {
    const [, day, month, year] = slashOrDash
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  }

  if (/^\d{4,6}$/.test(trimmed)) {
    const serial = Number(trimmed)
    const parsed = XLSX.SSF?.parse_date_code(serial)
    if (parsed?.y) {
      return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`
    }
  }

  return null
}

/** Downloads a starter .xlsx template so users know which columns to fill in. */
export function downloadExcelTemplate(filename: string, headers: string[], sampleRow?: string[]) {
  const worksheet = XLSX.utils.aoa_to_sheet(sampleRow ? [headers, sampleRow] : [headers])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1")
  XLSX.writeFile(workbook, filename)
}
