/**
 * Shared, client-safe helpers for the Financial Reports export engine.
 *
 * These utilities are the single source of truth for how a report is grouped,
 * subtotalled and formatted across every export surface (on-screen view, CSV,
 * Excel and PDF) so a Balance Sheet exported to PDF matches the same report
 * exported to Excel line-for-line. Keep this file free of any server-only or
 * browser-only imports — it is imported by both the React components and the
 * lazily-loaded PDF / Excel engines.
 */

export type ReportColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
  /** When false, this money column is formatted but never auto-totalled (the
   *  report carries its own subtotal/total rows, e.g. financial statements). */
  total?: boolean
  /** Force Indian dd-mm-yyyy date formatting for this column's values. Values
   *  that already look like ISO dates are auto-detected even without this. */
  date?: boolean
}

export type ReportRow = Record<string, any>

export type ReportCompany = {
  name: string
  addressLines: string[]
  email: string
  phone: string
  website: string
  taxLabel: string
  taxNumber: string
  /** Permanent Account Number, shown alongside GSTIN on statutory letterheads. */
  pan?: string
}

export type GroupSection = {
  group: string
  rows: ReportRow[]
  subtotals: Record<string, number>
}

export type ReportModel = {
  moneyCols: ReportColumn[]
  groupKey: string | null
  /** Ordered group sections with per-group subtotals, or null when the report is flat. */
  sections: GroupSection[] | null
  /** Grand totals across every money column, or null when there are none. */
  grandTotals: Record<string, number> | null
}

/**
 * Format a number using the Indian numbering system (lakh / crore grouping)
 * with parenthesised negatives — the convention Tally and Indian statutory
 * reports use. No currency glyph is added: the standard PDF core fonts cannot
 * render ₹, so exports state "Amounts in INR" once in the header instead. The
 * on-screen UI keeps the ₹ symbol via the settings-aware `inr0` helper.
 */
export function formatIndianNumber(value: number, decimals = 2): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ""
  const negative = n < 0
  const abs = Math.abs(n)
  const fixed = abs.toFixed(decimals)
  const [whole, fraction] = fixed.split(".")

  // Indian grouping: last 3 digits, then groups of 2.
  let grouped = whole
  if (whole.length > 3) {
    const last3 = whole.slice(-3)
    const rest = whole.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3
  }

  const out = fraction ? `${grouped}.${fraction}` : grouped
  return negative ? `(${out})` : out
}

// Matches an ISO date ("2026-09-15") or ISO datetime ("2026-09-15T10:30:00Z").
// Used to auto-detect date cells so every surface renders the Indian numeric
// format without each report having to tag its date columns.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** True when a value looks like an ISO date / datetime string. */
export function isIsoDateString(value: any): boolean {
  return typeof value === "string" && ISO_DATE_RE.test(value.trim())
}

/**
 * Format any date-ish value to the Indian numeric convention dd-mm-yyyy
 * (e.g. 15-09-2026), the format used consistently across the reports UI, PDF,
 * Excel and CSV. Non-date strings are returned unchanged so it is safe to run
 * over arbitrary cell values.
 */
export function formatIndianDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return ""
  let d: Date
  if (value instanceof Date) {
    d = value
  } else if (typeof value === "string") {
    const s = value.trim()
    if (!ISO_DATE_RE.test(s)) return value
    d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s)
  } else {
    d = new Date(value)
  }
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`
}

/** dd-mm-yyyy hh:mm AM/PM — used for "generated on" stamps. */
export function formatIndianDateTime(value?: string | number | Date | null): string {
  if (value === null || value === undefined || value === "") return ""
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  let h = d.getHours()
  const ampm = h >= 12 ? "PM" : "AM"
  h = h % 12 || 12
  return `${formatIndianDate(d)} ${p(h)}:${p(d.getMinutes())} ${ampm}`
}

/** Plain-text value for a cell in CSV / Excel / PDF (no em-dash placeholder). */
export function cellExportText(value: any, col: ReportColumn, decimals = 2): string {
  if (value === null || value === undefined || value === "") return ""
  if (col.money) return formatIndianNumber(Number(value) || 0, decimals)
  if (col.date || isIsoDateString(value)) return formatIndianDate(value)
  return String(value)
}

/**
 * The dimension a report is naturally grouped by, if any. Reports that expose
 * an account-group / group column render as a Tally-style hierarchy with
 * per-group subtotals; everything else stays flat. Purely presentational — the
 * row data itself is never mutated.
 */
export function groupColumnKey(columns: ReportColumn[]): string | null {
  const candidate = columns.find((c) => c.key === "account_group" || c.key === "group")
  if (candidate && columns.length > 2) return candidate.key
  return null
}

function sumColumns(rows: ReportRow[], moneyCols: ReportColumn[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const c of moneyCols) {
    totals[c.key] = rows.reduce((sum, r) => sum + (Number(r[c.key]) || 0), 0)
  }
  return totals
}

/**
 * Build the shared grouping / subtotal / grand-total model for a report. Both
 * the PDF and Excel engines consume this so their output stays identical.
 */
export function buildReportModel(columns: ReportColumn[], rows: ReportRow[]): ReportModel {
  const moneyCols = columns.filter((c) => c.money)
  // Columns that participate in subtotals / grand totals. A money column may
  // opt out (`total: false`) when the report supplies its own total rows.
  const totalCols = moneyCols.filter((c) => c.total !== false)
  const hasTotals = totalCols.length > 0 && rows.length > 0
  const grandTotals = hasTotals ? sumColumns(rows, totalCols) : null

  const groupKey = groupColumnKey(columns)
  let sections: GroupSection[] | null = null

  if (groupKey && rows.length > 0) {
    const order: string[] = []
    const map = new Map<string, ReportRow[]>()
    for (const r of rows) {
      const g = String(r[groupKey] ?? "—") || "—"
      if (!map.has(g)) {
        map.set(g, [])
        order.push(g)
      }
      map.get(g)!.push(r)
    }
    sections = order.map((g) => {
      const groupRows = map.get(g)!
      return { group: g, rows: groupRows, subtotals: sumColumns(groupRows, totalCols) }
    })
  }

  return { moneyCols, groupKey, sections, grandTotals }
}

/** Human-readable "generated on" stamp (dd-mm-yyyy hh:mm AM/PM) for headers. */
export function generatedStamp(generatedAt?: string): string {
  return formatIndianDateTime(generatedAt || new Date())
}

/** A safe, lowercased file-name stem for a downloaded report. */
export function reportFileStem(key: string): string {
  return (key || "report").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "report"
}

export type ReportExportPayload = {
  reportKey: string
  reportLabel: string
  reportDescription?: string
  columns: ReportColumn[]
  rows: ReportRow[]
  company: ReportCompany | null
  subtitle?: string
  filterLabels?: string[]
  generatedAt?: string
  /** Name of the user who generated this snapshot (Phase 20). */
  generatedBy?: string
  /** Financial-year context label (e.g. "FY 2026-27") for the footer. */
  financialYear?: string
}
