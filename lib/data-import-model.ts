/**
 * Enterprise Data Import (pure, testable model).
 * ---------------------------------------------------------------------------
 * An import takes a chosen DATASET (a module registered in IMPORT_CONFIGS), a
 * user-supplied FILE (CSV / Excel / JSON) parsed into raw rows, and a MAPPING
 * from each target column to a source header, then runs the shared pipeline:
 *
 *   map → validate → detect duplicates → preview → commit (with rollback)
 *
 * This module is the DB-free core: the public analysis / job shapes shared with
 * the UI (type-only), the duplicate fingerprint, the error-report serializer,
 * and the row-count guard. It carries no `server-only`, Node, or DB import so
 * it can be unit-tested directly and imported by the client for its types. The
 * DB store, coercion, validation and job execution live in
 * lib/data-import-store.ts.
 */

import type { ImportColumnType } from "@/lib/import-configs"

// ---------------------------------------------------------------------------
// Row + analysis shapes
// ---------------------------------------------------------------------------

export type ImportRowStatus = "valid" | "error" | "duplicate"

/** A single prepared row as surfaced in the preview / error report. */
export type ImportPreparedRow = {
  /** 1-based source row number (accounts for the header row on tabular files). */
  row: number
  status: ImportRowStatus
  messages: string[]
  /** Mapped + display-coerced values keyed by target column. */
  values: Record<string, string>
}

export type ImportColumnMeta = {
  key: string
  label: string
  type: ImportColumnType
  required: boolean
}

/** The result of a dry-run analysis — never writes anything. */
export type ImportAnalysis = {
  datasetKey: string
  datasetLabel: string
  /** Resolved target-column → source-header mapping (null = unmapped). */
  mapping: Record<string, string | null>
  columns: ImportColumnMeta[]
  headers: string[]
  totalRows: number
  validRows: number
  errorRows: number
  duplicateRows: number
  /** Required target columns with no source header mapped. */
  unmappedRequired: string[]
  /** Target columns used to detect duplicates. */
  dedupeKeys: string[]
  /** First N invalid/duplicate rows for an at-a-glance report. */
  issues: ImportErrorEntry[]
  /** First N prepared rows for the preview table. */
  preview: ImportPreparedRow[]
  canImport: boolean
  /** True when the upload was clipped to IMPORT_ROW_LIMIT. */
  truncated: boolean
}

export type ImportErrorEntry = {
  row: number
  type: "error" | "duplicate"
  messages: string[]
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const IMPORT_JOB_STATUSES = [
  "completed",
  "completed_with_errors",
  "failed",
  "rolled_back",
] as const
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number]

export const IMPORT_STATUS_LABELS: Record<ImportJobStatus, string> = {
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  rolled_back: "Rolled back",
}

export type ImportJobSummary = {
  id: number
  datasetKey: string
  datasetLabel: string
  fileName: string | null
  status: ImportJobStatus
  totalRows: number
  importedRows: number
  failedRows: number
  skippedRows: number
  errorCount: number
  rolledBack: boolean
  /** Whether the committed rows can still be undone (ids captured, not yet undone). */
  rollbackable: boolean
  requestedByName: string | null
  createdAt: string
  finishedAt: string | null
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard cap on rows accepted in one import. Keeps the JSON request body and the
 * per-row insert loop bounded; larger files should be split. The UI surfaces a
 * clear "truncated" notice rather than silently dropping data.
 */
export const IMPORT_ROW_LIMIT = 20_000

// ---------------------------------------------------------------------------
// Duplicate fingerprint
// ---------------------------------------------------------------------------

/**
 * A stable, case-insensitive fingerprint over a row's dedupe-key values. The
 * unit separator (\u0001) can never appear in a spreadsheet cell, so distinct
 * key tuples can never collide by concatenation.
 */
export function importFingerprint(values: (string | number | null | undefined)[]): string {
  return values.map((v) => String(v ?? "").trim().toLowerCase()).join("\u0001")
}

// ---------------------------------------------------------------------------
// Error-report serialization (CSV)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Serialize the stored issue list to a downloadable CSV error report. */
export function buildImportErrorCsv(entries: ImportErrorEntry[]): string {
  const lines = ["Row,Type,Details"]
  for (const e of entries) {
    lines.push([String(e.row), e.type, e.messages.join("; ")].map(csvEscape).join(","))
  }
  return "\uFEFF" + lines.join("\r\n")
}
