/**
 * Enterprise queued/resumable batch import (pure, testable model).
 * ---------------------------------------------------------------------------
 * Spec48 (#41-42, #98). The generic Import Center (lib/data-import-*.ts) runs a
 * whole file in one synchronous request, capped at IMPORT_ROW_LIMIT (20k). Very
 * large enterprise files (100k+ rows) need to be STAGED and processed in
 * resumable BATCHES so a single request never has to map → validate → insert
 * every row, and so an interrupted run can continue from its last checkpoint.
 *
 * This module is the DB-free core shared by the store, the routes and the UI:
 *   - batch planning + checkpoint/resume math,
 *   - progress + outcome accumulation,
 *   - the deterministic per-batch idempotency key,
 *   - formula-injection neutralization applied on INGEST (so a spreadsheet
 *     formula can never be stored and later re-exported as a live formula),
 *   - the downloadable row-level error-report serializer.
 *
 * It carries no `server-only`, Node or DB import so it can be unit-tested
 * directly and imported by the client for its types. The staging tables, row
 * pipeline reuse and job execution live in lib/data-import-batches-store.ts.
 */

import type { ImportErrorEntry } from "@/lib/data-import-model"

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Rows processed per resumable batch. Bounds each request's insert loop. */
export const BATCH_IMPORT_SIZE = 5_000

/**
 * Hard ceiling on rows accepted into one staged batch import. An order of
 * magnitude above the synchronous importer so 100k+ files are first-class,
 * while still bounding staging storage and total work per job.
 */
export const MAX_BATCH_IMPORT_ROWS = 500_000

/** Clamp a requested batch size to a safe, sensible window. */
export function clampBatchSize(size: unknown): number {
  const n = Number(size)
  if (!Number.isFinite(n)) return BATCH_IMPORT_SIZE
  return Math.min(50_000, Math.max(500, Math.floor(n)))
}

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

export const BATCH_IMPORT_STATUSES = [
  "staging",
  "validated",
  "queued",
  "running",
  "interrupted",
  "completed",
  "completed_with_errors",
  "failed",
  "rolled_back",
] as const
export type BatchImportStatus = (typeof BATCH_IMPORT_STATUSES)[number]

export const BATCH_IMPORT_STATUS_LABELS: Record<BatchImportStatus, string> = {
  staging: "Uploading",
  validated: "Validated",
  queued: "Queued",
  running: "Running",
  interrupted: "Interrupted",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  rolled_back: "Rolled back",
}

export function isBatchImportStatus(value: unknown): value is BatchImportStatus {
  return typeof value === "string" && (BATCH_IMPORT_STATUSES as readonly string[]).includes(value)
}

/** A batch job is finished (no more batches will be processed) in these states. */
export function isTerminalBatchStatus(status: BatchImportStatus): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed" || status === "rolled_back"
}

/** Rows may only be appended while the file is still being uploaded. */
export function canAppendRows(status: BatchImportStatus): boolean {
  return status === "staging"
}

/** Validation (full dry run) is allowed once uploaded, and may be re-run before start. */
export function canValidate(status: BatchImportStatus): boolean {
  return status === "staging" || status === "validated"
}

/** Only a validated job can be queued for commit. */
export function canStart(status: BatchImportStatus): boolean {
  return status === "validated"
}

/** An interrupted (or stuck queued/running) job resumes from its checkpoint. */
export function canResume(status: BatchImportStatus): boolean {
  return status === "interrupted" || status === "queued" || status === "running"
}

/**
 * Rollback is allowed for any job that has committed rows and is not currently
 * being processed (a running batch would race the delete).
 */
export function canRollback(status: BatchImportStatus, importedRows: number): boolean {
  if (importedRows <= 0) return false
  return status === "completed" || status === "completed_with_errors" || status === "interrupted" || status === "failed"
}

// ---------------------------------------------------------------------------
// Progress history
// ---------------------------------------------------------------------------

export const BATCH_EVENT_TYPES = [
  "created",
  "chunk_staged",
  "validated",
  "queued",
  "batch_committed",
  "interrupted",
  "resumed",
  "completed",
  "rolled_back",
] as const
export type BatchEventType = (typeof BATCH_EVENT_TYPES)[number]

export type BatchImportEvent = {
  id: number
  event: BatchEventType
  batchIndex: number | null
  detail: Record<string, unknown> | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Upload chunk validation (malformed-file defense, server side)
// ---------------------------------------------------------------------------

/** Rows per upload request — keeps each request body well under platform limits. */
export const BATCH_STAGE_CHUNK_MAX = 2_000
export const MAX_IMPORT_COLUMNS = 200
export const MAX_IMPORT_CELL_LENGTH = 10_000
export const MAX_IMPORT_HEADER_LENGTH = 190

export class ImportValidationError extends Error {}

/**
 * Validate one uploaded chunk of parsed rows. The browser parses the file, so
 * the server must never trust the shape: rows must be plain objects whose
 * values are primitives, with bounded column counts and cell sizes. Returns
 * normalized rows (all cells as trimmed-free strings or null).
 */
export function validateStagedChunk(rows: unknown): Record<string, string | null>[] {
  if (!Array.isArray(rows)) throw new ImportValidationError("rows must be an array")
  if (rows.length === 0) throw new ImportValidationError("A chunk must contain at least one row")
  if (rows.length > BATCH_STAGE_CHUNK_MAX) {
    throw new ImportValidationError(`A chunk may contain at most ${BATCH_STAGE_CHUNK_MAX} rows`)
  }
  const out: Record<string, string | null>[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ImportValidationError(`Row ${i + 1} of the chunk is not an object`)
    }
    const entries = Object.entries(row as Record<string, unknown>)
    if (entries.length > MAX_IMPORT_COLUMNS) {
      throw new ImportValidationError(`Row ${i + 1} has more than ${MAX_IMPORT_COLUMNS} columns`)
    }
    const clean: Record<string, string | null> = {}
    for (const [key, value] of entries) {
      if (key.length > MAX_IMPORT_HEADER_LENGTH || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new ImportValidationError(`Row ${i + 1} has an invalid column name`)
      }
      if (value == null) {
        clean[key] = null
        continue
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new ImportValidationError(`Row ${i + 1} column "${key.slice(0, 40)}" must be a text or number value`)
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new ImportValidationError(`Row ${i + 1} column "${key.slice(0, 40)}" is not a finite number`)
      }
      const str = String(value)
      if (str.length > MAX_IMPORT_CELL_LENGTH) {
        throw new ImportValidationError(`Row ${i + 1} column "${key.slice(0, 40)}" exceeds ${MAX_IMPORT_CELL_LENGTH} characters`)
      }
      clean[key] = str
    }
    out.push(clean)
  }
  return out
}

/** Header list validation for job creation. */
export function validateHeaders(headers: unknown): string[] {
  if (!Array.isArray(headers)) throw new ImportValidationError("headers must be an array")
  if (headers.length === 0) throw new ImportValidationError("The file has no header row")
  if (headers.length > MAX_IMPORT_COLUMNS) throw new ImportValidationError(`At most ${MAX_IMPORT_COLUMNS} columns are supported`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const h of headers) {
    if (typeof h !== "string" && typeof h !== "number") throw new ImportValidationError("Header names must be text")
    const name = String(h)
    if (name.length > MAX_IMPORT_HEADER_LENGTH) throw new ImportValidationError("A header name is too long")
    if (seen.has(name)) throw new ImportValidationError(`Duplicate column header "${name.slice(0, 40)}"`)
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Client-supplied idempotency key: 8-120 url-safe characters. */
export function isValidBatchIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(value)
}

// ---------------------------------------------------------------------------
// Planning + checkpoints
// ---------------------------------------------------------------------------

/** Number of batches needed to cover `totalRows` at `batchSize`. */
export function planBatchCount(totalRows: number, batchSize: number): number {
  const total = Math.max(0, Math.floor(totalRows))
  const size = Math.max(1, Math.floor(batchSize))
  return Math.ceil(total / size)
}

/** Inclusive-exclusive [start, end) row window (0-based) for a batch index. */
export function batchRowRange(batchIndex: number, batchSize: number, totalRows: number): { start: number; end: number } {
  const size = Math.max(1, Math.floor(batchSize))
  const start = Math.max(0, Math.floor(batchIndex)) * size
  const end = Math.min(Math.max(0, Math.floor(totalRows)), start + size)
  return { start: Math.min(start, end), end }
}

/**
 * The next batch index to process given how many have already completed. Returns
 * null when every batch is done — the checkpoint that makes a run RESUMABLE:
 * re-invoking after an interruption continues from the persisted count.
 */
export function nextBatchIndex(processedBatches: number, totalBatches: number): number | null {
  const done = Math.max(0, Math.floor(processedBatches))
  if (done >= Math.max(0, Math.floor(totalBatches))) return null
  return done
}

/** Whole-percent progress (0-100) of a staged import. */
export function batchProgressPercent(processedRows: number, totalRows: number): number {
  const total = Math.max(0, Math.floor(totalRows))
  if (total === 0) return 100
  const done = Math.min(total, Math.max(0, Math.floor(processedRows)))
  return Math.round((done / total) * 100)
}

// ---------------------------------------------------------------------------
// Outcome accumulation
// ---------------------------------------------------------------------------

export type BatchOutcome = {
  imported: number
  failed: number
  skipped: number
  importedIds: number[]
  issues: ImportErrorEntry[]
}

export function emptyOutcome(): BatchOutcome {
  return { imported: 0, failed: 0, skipped: 0, importedIds: [], issues: [] }
}

/** Fold a freshly-processed batch's result into the running job totals. */
export function mergeOutcome(acc: BatchOutcome, batch: BatchOutcome, issueLimit = 2_000): BatchOutcome {
  const issues = acc.issues.concat(batch.issues).slice(0, issueLimit)
  return {
    imported: acc.imported + batch.imported,
    failed: acc.failed + batch.failed,
    skipped: acc.skipped + batch.skipped,
    importedIds: acc.importedIds.concat(batch.importedIds),
    issues,
  }
}

/**
 * The final status once every batch has been processed. `rollbackable` mirrors
 * the synchronous importer: a job is rollback-eligible only when every imported
 * row was captured by an auto-increment id.
 */
export function finalBatchStatus(outcome: BatchOutcome): BatchImportStatus {
  if (outcome.imported === 0) return "failed"
  if (outcome.failed > 0 || outcome.issues.length > 0) return "completed_with_errors"
  return "completed"
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Deterministic key so a retried "process this batch" can never double-insert:
 * the store marks staged rows processed under this key and skips a batch whose
 * rows are already committed.
 */
export function batchCommitKey(jobId: number | string, batchIndex: number): string {
  return `batch:${jobId}:${batchIndex}`
}

// ---------------------------------------------------------------------------
// Formula-injection neutralization (CSV / spreadsheet safety)
// ---------------------------------------------------------------------------

/** Leading characters a spreadsheet interprets as the start of a formula. */
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r", "\n"])

/**
 * `+` / `-` also start legitimate data: signed numbers ("-12.50") and phone
 * numbers ("+91 98765 43210", "+1 (555) 010-2000"). Those are inert in every
 * spreadsheet, so they are left untouched; anything else after the sign (e.g.
 * `+HYPERLINK(...)`, `-2+3+cmd|' /C calc'!A0`) is treated as a formula.
 */
const SIGNED_LITERAL = /^[+-][\d\s().,-]*\d[\d\s().,-]*$/

/** True when a raw string cell would be executed as a formula by a spreadsheet. */
export function looksLikeFormula(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  if (!FORMULA_TRIGGERS.has(value[0])) return false
  if ((value[0] === "+" || value[0] === "-") && SIGNED_LITERAL.test(value)) return false
  return true
}

/**
 * Neutralize a value that a spreadsheet would execute as a formula (CSV
 * injection / "DDE" attacks such as `=cmd|...`, `+HYPERLINK(...)`,
 * `@SUM(...)`). We prefix a single quote, the canonical, reversible defense, so
 * the cell renders as literal text. Applied on INGEST so the value is stored
 * inert, and again on EXPORT for data that predates ingest neutralization.
 * Idempotent: an already-quoted value starts with `'` and is left alone.
 */
export function neutralizeFormula(value: unknown): unknown {
  return looksLikeFormula(value) ? `'${value as string}` : value
}

/** Neutralize every string cell of a raw row (mutation-free copy). */
export function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = neutralizeFormula(value)
  return out
}

// ---------------------------------------------------------------------------
// Error-report serialization (CSV, formula-safe)
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  const safe = neutralizeFormula(value) as string
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Serialize a staged import's issue list to a downloadable, safe CSV. */
export function buildBatchErrorCsv(entries: ImportErrorEntry[]): string {
  const lines = ["Row,Type,Details"]
  for (const e of entries) {
    lines.push([String(e.row), e.type, e.messages.join("; ")].map(csvCell).join(","))
  }
  return "\uFEFF" + lines.join("\r\n")
}

// ---------------------------------------------------------------------------
// Public job shape (shared with the UI)
// ---------------------------------------------------------------------------

export type BatchImportSummary = {
  id: number
  datasetKey: string
  datasetLabel: string
  adapterKey: string | null
  fileName: string | null
  status: BatchImportStatus
  totalRows: number
  totalBatches: number
  batchSize: number
  processedBatches: number
  processedRows: number
  importedRows: number
  failedRows: number
  skippedRows: number
  stagedRows: number
  /** Dry-run counts from the last validation pass (null until validated). */
  validation: { validRows: number; errorRows: number; duplicateRows: number; unmappedRequired: string[] } | null
  errorCount: number
  progressPercent: number
  lastError: string | null
  rolledBack: boolean
  rollbackable: boolean
  requestedByName: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}
