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
  "queued",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "rolled_back",
] as const
export type BatchImportStatus = (typeof BATCH_IMPORT_STATUSES)[number]

export const BATCH_IMPORT_STATUS_LABELS: Record<BatchImportStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  rolled_back: "Rolled back",
}

/** A batch job is finished (no more batches will be processed) in these states. */
export function isTerminalBatchStatus(status: BatchImportStatus): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed" || status === "rolled_back"
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
 * Neutralize a value that a spreadsheet would execute as a formula (CSV
 * injection / "DDE" attacks such as `=cmd|...`, `+HYPERLINK(...)`,
 * `@SUM(...)`). We prefix a single quote, the canonical, reversible defense, so
 * the cell renders as literal text. Applied on INGEST so the value is stored
 * inert and stays inert through any later export. Non-strings pass through.
 */
export function neutralizeFormula(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (value.length === 0) return value
  return FORMULA_TRIGGERS.has(value[0]) ? `'${value}` : value
}

/** True when a raw string cell would be executed as a formula by a spreadsheet. */
export function looksLikeFormula(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && FORMULA_TRIGGERS.has(value[0])
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
  errorCount: number
  progressPercent: number
  rolledBack: boolean
  rollbackable: boolean
  requestedByName: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}
