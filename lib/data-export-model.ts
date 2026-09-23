/**
 * SPEC 73 — Tenant Data Export (pure, testable model).
 * ---------------------------------------------------------------------------
 * A data export takes a SCOPE (a single module dataset, or the whole tenant)
 * and renders it in a FORMAT (CSV / Excel / JSON / PDF), respecting the acting
 * role's permissions and the SPEC 69 data-classification export rules.
 *
 * This module is the DB-free core: format/status/frequency normalization, the
 * row serializers that don't need a third-party library (CSV + JSON), the
 * array-of-arrays builder the Excel/PDF serializers consume, filename shaping,
 * and the download-token TTL math. It carries no `server-only`, Node, or DB
 * import so it can be unit-tested directly and (type-only) shared with the UI.
 * The DB store, request wiring, and xlsx/pdf serializers live in
 * lib/data-export-store.ts.
 */

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ["csv", "xlsx", "json", "pdf"] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
  json: "JSON",
  pdf: "PDF",
}

const FORMAT_ALIASES: Record<string, ExportFormat> = {
  csv: "csv",
  excel: "xlsx",
  xlsx: "xlsx",
  xls: "xlsx",
  json: "json",
  pdf: "pdf",
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value)
}

/** Coerce arbitrary (UI label or code) input to a valid format, defaulting to CSV. */
export function toExportFormat(value: unknown): ExportFormat {
  if (typeof value !== "string") return "csv"
  return FORMAT_ALIASES[value.trim().toLowerCase()] ?? "csv"
}

export function exportFileExtension(format: ExportFormat): string {
  return format === "xlsx" ? "xlsx" : format
}

export function exportContentType(format: ExportFormat): string {
  switch (format) {
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "json":
      return "application/json; charset=utf-8"
    case "pdf":
      return "application/pdf"
    case "csv":
    default:
      return "text/csv; charset=utf-8"
  }
}

// ---------------------------------------------------------------------------
// Status & scope
// ---------------------------------------------------------------------------

export const EXPORT_STATUSES = ["queued", "running", "completed", "failed", "expired"] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

export function isExportStatus(value: unknown): value is ExportStatus {
  return typeof value === "string" && (EXPORT_STATUSES as readonly string[]).includes(value)
}

/** Sentinel scope key that means "every exportable dataset for the tenant". */
export const FULL_TENANT_EXPORT_KEY = "__full_tenant__"

export function isFullTenantScope(datasetKey: string): boolean {
  return datasetKey === FULL_TENANT_EXPORT_KEY
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export const EXPORT_FREQUENCIES = ["daily", "weekly", "monthly"] as const
export type ExportFrequency = (typeof EXPORT_FREQUENCIES)[number]

export function isExportFrequency(value: unknown): value is ExportFrequency {
  return typeof value === "string" && (EXPORT_FREQUENCIES as readonly string[]).includes(value)
}

export function toExportFrequency(value: unknown): ExportFrequency {
  return isExportFrequency(value) ? value : "weekly"
}

const DAY_MS = 86_400_000

/**
 * Next UTC 03:30 boundary at/after which a schedule of this frequency becomes
 * due, measured from `lastRunAt` (or `from` when it has never run). Pure over
 * its inputs so scheduling is deterministic in tests. The 03:30 offset keeps
 * scheduled exports just behind the 03:00 retention sweep.
 */
export function computeNextExportRun(
  frequency: ExportFrequency,
  lastRunAt: Date | null,
  from: Date = new Date(),
): Date {
  const anchor = lastRunAt ?? from
  const next = new Date(anchor)
  const step = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 30
  next.setUTCDate(next.getUTCDate() + step)
  next.setUTCHours(3, 30, 0, 0)
  // Never schedule in the past relative to `from`.
  if (next.getTime() <= from.getTime()) {
    const bumped = new Date(from)
    bumped.setUTCHours(3, 30, 0, 0)
    if (bumped.getTime() <= from.getTime()) bumped.setTime(bumped.getTime() + DAY_MS)
    return bumped
  }
  return next
}

/** Whether a schedule with this next-run timestamp is due to run now. */
export function isScheduleDue(nextRunAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!nextRunAt) return false
  const d = nextRunAt instanceof Date ? nextRunAt : new Date(nextRunAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Download-token TTL
// ---------------------------------------------------------------------------

/** Default lifetime of a generated export artifact + its download link. */
export const DEFAULT_EXPORT_TTL_SECONDS = 60 * 60 * 24 // 24 hours
/** Hard ceiling so an export can never become an effectively-permanent link. */
export const MAX_EXPORT_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

export function clampExportTtl(ttlSeconds: number | undefined): number {
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds as number) : DEFAULT_EXPORT_TTL_SECONDS
  if (ttl <= 0) return DEFAULT_EXPORT_TTL_SECONDS
  return Math.min(ttl, MAX_EXPORT_TTL_SECONDS)
}

/** True once an export's expiry timestamp has passed. */
export function isExportExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/** Slugify a dataset/module label into a filesystem- and header-safe stem. */
export function slugifyLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export"
  )
}

/** Build a stable, dated filename for a generated export. */
export function exportFileName(label: string, format: ExportFormat, when: Date = new Date()): string {
  const stamp = when.toISOString().slice(0, 10)
  return `${slugifyLabel(label)}-${stamp}.${exportFileExtension(format)}`
}

// ---------------------------------------------------------------------------
// Serialization primitives
// ---------------------------------------------------------------------------

/** Render any DB cell value into a flat string suitable for CSV / spreadsheet. */
export function stringifyCell(value: unknown): string {
  if (value == null) return ""
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The stable union of keys across a set of rows, preserving first-seen order.
 * Used so a serialized dataset has a deterministic, complete column set even
 * when individual rows omit null columns.
 */
export function collectColumns(rows: Record<string, unknown>[], preferred?: string[]): string[] {
  const seen = new Set<string>()
  const cols: string[] = []
  for (const key of preferred ?? []) {
    if (!seen.has(key)) {
      seen.add(key)
      cols.push(key)
    }
  }
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        cols.push(key)
      }
    }
  }
  return cols
}

/** Serialize rows to CSV text. A leading BOM keeps Excel happy with UTF-8. */
export function serializeCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? collectColumns(rows)
  const lines = [cols.map((c) => csvEscape(c)).join(",")]
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(stringifyCell(row[c]))).join(","))
  }
  return "\uFEFF" + lines.join("\r\n")
}

/** Serialize a single dataset (or a keyed map of datasets) to pretty JSON. */
export function serializeJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

/**
 * Build the array-of-arrays a spreadsheet/PDF table renderer consumes: a header
 * row of column names followed by one array per data row. Pure so the xlsx/pdf
 * serializers in the store stay thin.
 */
export function buildTable(rows: Record<string, unknown>[], columns?: string[]): { columns: string[]; aoa: string[][] } {
  const cols = columns ?? collectColumns(rows)
  const aoa = [cols.slice(), ...rows.map((row) => cols.map((c) => stringifyCell(row[c])))]
  return { columns: cols, aoa }
}
