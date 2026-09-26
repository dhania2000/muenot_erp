import "server-only"

// Spec48 — queued, resumable batch importer for 100k+ row files.
//
// Flow: create (idempotent) → stage chunks (idempotent per row number) →
// validate (preview, no writes to the target table) → start (enqueues a
// `data.import_batch` job on the shared durable queue) → worker commits one
// batch per transaction and checkpoints → rollback deletes the exact ids.
//
// It reuses the Import Center row pipeline (prepareImportRun / prepareStagedRows
// / insertPreparedRow / deleteInsertedRows) so mapping, coercion, validation,
// dedupe, tenant forcing and id minting behave identically to small imports.
// Every job lookup carries a tenant predicate except the worker entry point,
// which rehydrates the tenant from the persisted job row.

import type { PoolConnection } from "mysql2/promise"
import { query, tableColumns, withTransaction } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { enqueueBackgroundJob } from "@/lib/background-jobs"
import { getImportDataset } from "@/lib/data-import-catalog"
import {
  prepareImportRun,
  prepareStagedRows,
  insertPreparedRow,
  deleteInsertedRows,
  type ImportActor,
  type ImportRun,
} from "@/lib/data-import-store"
import { applyAdapter, getImportAdapter, isAdapterAvailable } from "@/lib/import-adapters"
import {
  BATCH_STAGE_CHUNK_MAX,
  ImportValidationError,
  MAX_BATCH_IMPORT_ROWS,
  batchProgressPercent,
  canAppendRows,
  canResume,
  canRollback,
  canStart,
  canValidate,
  clampBatchSize,
  isBatchImportStatus,
  isTerminalBatchStatus,
  neutralizeFormula,
  planBatchCount,
  validateHeaders,
  validateStagedChunk,
  type BatchEventType,
  type BatchImportEvent,
  type BatchImportStatus,
} from "@/lib/data-import-batches-model"

export { ImportValidationError }

/** Wall-clock budget per worker invocation before handing off to a continuation job. */
const WORKER_TIME_BUDGET_MS = 240_000
const VALIDATION_ISSUE_SAMPLE = 200
const READ_PAGE = 5_000

export class BatchImportNotFoundError extends Error {
  constructor() {
    super("Import job not found")
  }
}
export class BatchImportStateError extends Error {}

// ---------------------------------------------------------------------------
// Schema (migrations are the source of truth; this self-heals like the rest of the app)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = await tableColumns(table)
  if (!cols.has(column.toLowerCase())) await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
}

async function runEnsure() {
  await query(`CREATE TABLE IF NOT EXISTS data_import_batch_jobs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED DEFAULT NULL,
    dataset_key VARCHAR(120) NOT NULL,
    dataset_label VARCHAR(190) NOT NULL,
    adapter_key VARCHAR(120) DEFAULT NULL,
    file_name VARCHAR(190) DEFAULT NULL,
    target_table VARCHAR(190) DEFAULT NULL,
    tenant_column VARCHAR(120) DEFAULT NULL,
    status VARCHAR(28) NOT NULL DEFAULT 'queued',
    total_rows INT UNSIGNED NOT NULL DEFAULT 0,
    total_batches INT UNSIGNED NOT NULL DEFAULT 0,
    batch_size INT UNSIGNED NOT NULL DEFAULT 5000,
    processed_batches INT UNSIGNED NOT NULL DEFAULT 0,
    imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
    failed_rows INT UNSIGNED NOT NULL DEFAULT 0,
    skipped_rows INT UNSIGNED NOT NULL DEFAULT 0,
    mapping JSON DEFAULT NULL,
    error_report LONGTEXT DEFAULT NULL,
    imported_ids LONGTEXT DEFAULT NULL,
    has_id_pk TINYINT(1) NOT NULL DEFAULT 0,
    rolled_back TINYINT(1) NOT NULL DEFAULT 0,
    idempotency_key VARCHAR(190) DEFAULT NULL,
    requested_by INT UNSIGNED DEFAULT NULL,
    error TEXT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_batch_job_idem (tenant_id, idempotency_key),
    KEY idx_batch_job_tenant (tenant_id, created_at),
    KEY idx_batch_job_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS data_import_batch_rows (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_id INT UNSIGNED NOT NULL,
    tenant_id INT UNSIGNED DEFAULT NULL,
    batch_index INT UNSIGNED NOT NULL,
    row_number INT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    processed TINYINT(1) NOT NULL DEFAULT 0,
    outcome VARCHAR(16) DEFAULT NULL,
    messages TEXT DEFAULT NULL,
    inserted_id BIGINT UNSIGNED DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_batch_rows_job_row (job_id, row_number),
    KEY idx_batch_rows_job_batch (job_id, batch_index),
    KEY idx_batch_rows_outcome (job_id, outcome),
    KEY idx_batch_rows_tenant (tenant_id),
    CONSTRAINT fk_batch_rows_job FOREIGN KEY (job_id) REFERENCES data_import_batch_jobs (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS data_import_batch_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_id INT UNSIGNED NOT NULL,
    tenant_id INT UNSIGNED DEFAULT NULL,
    event VARCHAR(32) NOT NULL,
    batch_index INT UNSIGNED DEFAULT NULL,
    detail JSON DEFAULT NULL,
    actor_id INT UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_batch_events_job (job_id, id),
    KEY idx_batch_events_tenant (tenant_id),
    CONSTRAINT fk_batch_events_job FOREIGN KEY (job_id) REFERENCES data_import_batch_jobs (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  // Converge databases created by the first Spec48 migration only.
  await addColumnIfMissing("data_import_batch_rows", "outcome", "`outcome` VARCHAR(16) DEFAULT NULL")
  await addColumnIfMissing("data_import_batch_rows", "messages", "`messages` TEXT DEFAULT NULL")
  await addColumnIfMissing("data_import_batch_rows", "inserted_id", "`inserted_id` BIGINT UNSIGNED DEFAULT NULL")
  await addColumnIfMissing("data_import_batch_jobs", "staged_rows", "`staged_rows` INT UNSIGNED NOT NULL DEFAULT 0")
  await addColumnIfMissing("data_import_batch_jobs", "headers", "`headers` JSON DEFAULT NULL")
  await addColumnIfMissing("data_import_batch_jobs", "validation", "`validation` JSON DEFAULT NULL")
  await addColumnIfMissing("data_import_batch_jobs", "requested_by_name", "`requested_by_name` VARCHAR(191) DEFAULT NULL")
}

export async function ensureBatchSchema(): Promise<void> {
  ensured ??= runEnsure().catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

// ---------------------------------------------------------------------------
// Types + projection
// ---------------------------------------------------------------------------

type JobRow = {
  id: number
  tenant_id: number | null
  dataset_key: string
  dataset_label: string
  adapter_key: string | null
  file_name: string | null
  target_table: string | null
  tenant_column: string | null
  status: string
  total_rows: number
  staged_rows: number
  total_batches: number
  batch_size: number
  processed_batches: number
  imported_rows: number
  failed_rows: number
  skipped_rows: number
  mapping: unknown
  headers: unknown
  validation: unknown
  has_id_pk: number
  rolled_back: number
  idempotency_key: string | null
  requested_by: number | null
  requested_by_name: string | null
  error: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export type BatchValidationSummary = {
  valid: number
  invalid: number
  duplicate: number
  unmappedRequired: string[]
  sample: { rowNumber: number; status: "invalid" | "duplicate"; messages: string[] }[]
  validatedAt: string
}

export type BatchImportJob = {
  id: number
  datasetKey: string
  datasetLabel: string
  adapterKey: string | null
  fileName: string | null
  status: BatchImportStatus
  totalRows: number
  stagedRows: number
  totalBatches: number
  batchSize: number
  processedBatches: number
  importedRows: number
  failedRows: number
  skippedRows: number
  progressPercent: number
  canRollback: boolean
  canResume: boolean
  rolledBack: boolean
  validation: BatchValidationSummary | null
  requestedByName: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

function statusOf(row: JobRow): BatchImportStatus {
  return isBatchImportStatus(row.status) ? row.status : "failed"
}

function project(row: JobRow): BatchImportJob {
  const status = statusOf(row)
  const processedRows = Number(row.imported_rows) + Number(row.failed_rows) + Number(row.skipped_rows)
  return {
    id: Number(row.id),
    datasetKey: row.dataset_key,
    datasetLabel: row.dataset_label,
    adapterKey: row.adapter_key,
    fileName: row.file_name,
    status,
    totalRows: Number(row.total_rows),
    stagedRows: Number(row.staged_rows),
    totalBatches: Number(row.total_batches),
    batchSize: Number(row.batch_size),
    processedBatches: Number(row.processed_batches),
    importedRows: Number(row.imported_rows),
    failedRows: Number(row.failed_rows),
    skippedRows: Number(row.skipped_rows),
    progressPercent: batchProgressPercent(processedRows, Number(row.total_rows)),
    canRollback: Boolean(row.has_id_pk) && !row.rolled_back && canRollback(status, Number(row.imported_rows)),
    canResume: canResume(status),
    rolledBack: Boolean(row.rolled_back),
    validation: parseJson<BatchValidationSummary | null>(row.validation, null),
    requestedByName: row.requested_by_name,
    error: row.error,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  }
}

function tenantScope(tenantId: number | null): { sql: string; params: unknown[] } {
  return tenantId == null ? { sql: "tenant_id IS NULL", params: [] } : { sql: "tenant_id = ?", params: [tenantId] }
}

async function loadJob(tenantId: number | null, jobId: number): Promise<JobRow> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new BatchImportNotFoundError()
  const scope = tenantScope(tenantId)
  const rows = (await query(`SELECT * FROM data_import_batch_jobs WHERE id = ? AND ${scope.sql} LIMIT 1`, [
    jobId,
    ...scope.params,
  ])) as JobRow[]
  if (!rows[0]) throw new BatchImportNotFoundError()
  return rows[0]
}

async function recordEvent(
  job: Pick<JobRow, "id" | "tenant_id">,
  event: BatchEventType,
  detail: Record<string, unknown> | null,
  options: { batchIndex?: number | null; actorId?: number | null; conn?: PoolConnection } = {},
) {
  const sql = `INSERT INTO data_import_batch_events (job_id, tenant_id, event, batch_index, detail, actor_id) VALUES (?, ?, ?, ?, ?, ?)`
  const params = [job.id, job.tenant_id, event, options.batchIndex ?? null, detail ? JSON.stringify(detail) : null, options.actorId ?? null]
  if (options.conn) await options.conn.query(sql, params)
  else await query(sql, params)
}

function stringMapping(value: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 190) continue
    out[k] = v == null || v === "" ? null : String(v).slice(0, 190)
  }
  return out
}

// ---------------------------------------------------------------------------
// Create (idempotent)
// ---------------------------------------------------------------------------

export type CreateBatchImportInput = {
  datasetKey?: string
  adapterKey?: string | null
  fileName?: string | null
  headers: unknown
  mapping?: unknown
  totalRows: unknown
  batchSize?: unknown
  idempotencyKey: string
}

export async function createBatchImport(
  tenantId: number | null,
  actor: ImportActor,
  input: CreateBatchImportInput,
): Promise<{ job: BatchImportJob; created: boolean }> {
  await ensureBatchSchema()
  const scope = tenantScope(tenantId)
  const existing = (await query(
    `SELECT * FROM data_import_batch_jobs WHERE idempotency_key = ? AND ${scope.sql} LIMIT 1`,
    [input.idempotencyKey, ...scope.params],
  )) as JobRow[]
  if (existing[0]) return { job: project(existing[0]), created: false }

  const rawHeaders = validateHeaders(input.headers)
  let datasetKey = String(input.datasetKey ?? "").trim()
  let headers = rawHeaders
  let mapping: Record<string, string | null> = stringMapping(input.mapping)
  let adapterKey: string | null = null

  if (input.adapterKey) {
    const adapter = getImportAdapter(String(input.adapterKey))
    if (!adapter || !isAdapterAvailable(adapter)) throw new ImportValidationError("Unknown or unavailable import adapter")
    adapterKey = adapter.key
    datasetKey = adapter.datasetKey
    // Rows are transformed at staging time; the job stores target-keyed headers.
    const shape = applyAdapter(adapter, [Object.fromEntries(rawHeaders.map((h) => [h, "x"]))])
    if (shape.headers.length === 0) throw new ImportValidationError("None of the file's columns match this adapter")
    headers = shape.headers
    mapping = shape.mapping
  }

  if (!datasetKey || !getImportDataset(datasetKey)) throw new ImportValidationError("Unknown or unsupported dataset")
  const totalRows = Number(input.totalRows)
  if (!Number.isSafeInteger(totalRows) || totalRows <= 0) throw new ImportValidationError("The file has no data rows")
  if (totalRows > MAX_BATCH_IMPORT_ROWS) {
    throw new ImportValidationError(`At most ${MAX_BATCH_IMPORT_ROWS.toLocaleString()} rows per import`)
  }
  const batchSize = clampBatchSize(input.batchSize)

  const run = await prepareImportRun(tenantId, datasetKey, headers, mapping)
  const fileName = input.fileName ? String(input.fileName).slice(0, 190) : null

  let insertId: number
  try {
    const res = (await query(
      `INSERT INTO data_import_batch_jobs
        (tenant_id, dataset_key, dataset_label, adapter_key, file_name, target_table, tenant_column, status,
         total_rows, total_batches, batch_size, mapping, headers, has_id_pk, idempotency_key, requested_by, requested_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        datasetKey,
        run.datasetLabel,
        adapterKey,
        fileName,
        run.config.table,
        run.tenantColumn,
        totalRows,
        planBatchCount(totalRows, batchSize),
        batchSize,
        JSON.stringify(run.mapping),
        JSON.stringify(headers),
        run.hasIdPk ? 1 : 0,
        input.idempotencyKey,
        actor.userId,
        actor.name?.slice(0, 191) ?? null,
      ],
    )) as { insertId: number }
    insertId = Number(res.insertId)
  } catch (err) {
    // Concurrent create with the same key: return the winner.
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
      const again = (await query(
        `SELECT * FROM data_import_batch_jobs WHERE idempotency_key = ? AND ${scope.sql} LIMIT 1`,
        [input.idempotencyKey, ...scope.params],
      )) as JobRow[]
      if (again[0]) return { job: project(again[0]), created: false }
    }
    throw err
  }

  const job = await loadJob(tenantId, insertId)
  await recordEvent(job, "created", { totalRows, batchSize, adapterKey, fileName }, { actorId: actor.userId })
  await recordAuditLog({
    action: "data.import_batch_create",
    entityType: "data_import_batch",
    entityId: String(insertId),
    entityLabel: run.datasetLabel,
    result: "success",
    after: { totalRows, batchSize, adapterKey, fileName },
  }).catch(() => {})
  return { job: project(job), created: true }
}

// ---------------------------------------------------------------------------
// Stage chunks (idempotent per row number)
// ---------------------------------------------------------------------------

export async function stageBatchRows(
  tenantId: number | null,
  jobId: number,
  input: { startRow: unknown; rows: unknown },
): Promise<BatchImportJob> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  if (!canAppendRows(statusOf(job))) throw new BatchImportStateError("Rows can only be added while the import is staging")
  const startRow = Number(input.startRow)
  if (!Number.isSafeInteger(startRow) || startRow < 0) throw new ImportValidationError("startRow must be a non-negative integer")
  let rows: Record<string, unknown>[] = validateStagedChunk(input.rows)
  if (startRow + rows.length > Number(job.total_rows)) {
    throw new ImportValidationError("The chunk exceeds the declared row count")
  }
  if (job.adapter_key) {
    const adapter = getImportAdapter(job.adapter_key)
    if (!adapter) throw new ImportValidationError("The import adapter is no longer available")
    rows = applyAdapter(adapter, rows).rows
  }

  const batchSize = Number(job.batch_size)
  const values: unknown[] = []
  const placeholders: string[] = []
  rows.forEach((raw, i) => {
    const index = startRow + i
    placeholders.push("(?, ?, ?, ?, ?)")
    values.push(job.id, job.tenant_id, Math.floor(index / batchSize), index + 2, JSON.stringify(raw))
  })
  // INSERT IGNORE on (job_id, row_number): a retried chunk never double-stages.
  await query(
    `INSERT IGNORE INTO data_import_batch_rows (job_id, tenant_id, batch_index, row_number, payload) VALUES ${placeholders.join(", ")}`,
    values,
  )
  const count = (await query(`SELECT COUNT(*) AS n FROM data_import_batch_rows WHERE job_id = ?`, [job.id])) as { n: number }[]
  const staged = Number(count[0]?.n ?? 0)
  await query(`UPDATE data_import_batch_jobs SET staged_rows = ?, validation = NULL WHERE id = ?`, [staged, job.id])
  await recordEvent(job, "chunk_staged", { startRow, rows: rows.length, staged })
  return project(await loadJob(tenantId, jobId))
}

// ---------------------------------------------------------------------------
// Validate (preview; never touches the target table)
// ---------------------------------------------------------------------------

async function runForJob(job: JobRow, withIdMinter: boolean): Promise<ImportRun> {
  return prepareImportRun(job.tenant_id, job.dataset_key, parseJson<string[]>(job.headers, []), stringMapping(parseJson(job.mapping, {})), {
    withIdMinter,
  })
}

type StagedRow = { id: number; batch_index: number; row_number: number; payload: unknown }

export async function validateBatchImport(tenantId: number | null, jobId: number): Promise<BatchImportJob> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  if (!canValidate(statusOf(job))) throw new BatchImportStateError("This import can no longer be validated")
  if (Number(job.staged_rows) !== Number(job.total_rows)) {
    throw new BatchImportStateError(`Only ${job.staged_rows} of ${job.total_rows} rows have been uploaded`)
  }
  const run = await runForJob(job, false)
  const seen = new Set<string>()
  const summary: BatchValidationSummary = {
    valid: 0,
    invalid: 0,
    duplicate: 0,
    unmappedRequired: run.unmappedRequired,
    sample: [],
    validatedAt: new Date().toISOString(),
  }
  let afterId = 0
  for (;;) {
    const page = (await query(
      `SELECT id, batch_index, row_number, payload FROM data_import_batch_rows WHERE job_id = ? AND id > ? ORDER BY id LIMIT ${READ_PAGE}`,
      [job.id, afterId],
    )) as StagedRow[]
    if (page.length === 0) break
    afterId = Number(page[page.length - 1].id)
    const prepared = prepareStagedRows(
      run,
      page.map((r) => ({ rowNumber: Number(r.row_number), raw: parseJson<Record<string, unknown>>(r.payload, {}) })),
      seen,
    )
    prepared.forEach((row, i) => {
      if (row.status === "valid") summary.valid++
      else {
        if (row.status === "duplicate") summary.duplicate++
        else summary.invalid++
        if (summary.sample.length < VALIDATION_ISSUE_SAMPLE) {
          summary.sample.push({
            rowNumber: Number(page[i].row_number),
            status: row.status === "duplicate" ? "duplicate" : "invalid",
            messages: row.messages.slice(0, 5),
          })
        }
      }
    })
  }
  await query(`UPDATE data_import_batch_jobs SET status = 'validated', validation = ? WHERE id = ?`, [
    JSON.stringify(summary),
    job.id,
  ])
  await recordEvent(job, "validated", { valid: summary.valid, invalid: summary.invalid, duplicate: summary.duplicate })
  return project(await loadJob(tenantId, jobId))
}

// ---------------------------------------------------------------------------
// Start / resume (enqueue on the shared durable queue)
// ---------------------------------------------------------------------------

async function enqueue(job: JobRow, key: string) {
  await enqueueBackgroundJob({
    jobType: "data.import_batch",
    tenantId: Number(job.tenant_id ?? 0),
    payload: { runId: Number(job.id) },
    idempotencyKey: key,
    concurrencyKey: `data-import:${job.tenant_id ?? 0}`,
    concurrencyLimit: 1,
    maxAttempts: 5,
    timeoutSeconds: 300,
  })
}

export async function startBatchImport(tenantId: number | null, actor: ImportActor, jobId: number): Promise<BatchImportJob> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  const status = statusOf(job)
  if (status === "queued" || status === "running") return project(job) // idempotent re-submit
  if (!canStart(status)) throw new BatchImportStateError("Validate the import before starting it")
  const validation = parseJson<BatchValidationSummary | null>(job.validation, null)
  if (validation?.unmappedRequired.length) {
    throw new BatchImportStateError(`Map the required columns first: ${validation.unmappedRequired.join(", ")}`)
  }
  const res = (await query(`UPDATE data_import_batch_jobs SET status = 'queued', error = NULL WHERE id = ? AND status = ?`, [
    job.id,
    status,
  ])) as { affectedRows?: number }
  if (!res.affectedRows) return project(await loadJob(tenantId, jobId))
  await enqueue(job, `data-import:${job.id}:start`)
  await recordEvent(job, "queued", { totalBatches: job.total_batches }, { actorId: actor.userId })
  await recordAuditLog({
    action: "data.import_batch_start",
    entityType: "data_import_batch",
    entityId: String(job.id),
    entityLabel: job.dataset_label,
    result: "success",
    after: { totalRows: job.total_rows, totalBatches: job.total_batches },
  }).catch(() => {})
  return project(await loadJob(tenantId, jobId))
}

export async function resumeBatchImport(
  tenantId: number | null,
  actor: ImportActor,
  jobId: number,
  idempotencyKey: string,
): Promise<BatchImportJob> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  if (!canResume(statusOf(job))) throw new BatchImportStateError("Only interrupted or stalled imports can be resumed")
  await query(`UPDATE data_import_batch_jobs SET status = 'queued', error = NULL WHERE id = ?`, [job.id])
  await enqueue(job, `data-import:${job.id}:resume:${idempotencyKey}`)
  await recordEvent(job, "resumed", { processedBatches: job.processed_batches }, { actorId: actor.userId })
  return project(await loadJob(tenantId, jobId))
}

// ---------------------------------------------------------------------------
// Worker (queue handler)
// ---------------------------------------------------------------------------

type BatchCommitResult = { imported: number; failed: number; skipped: number; done: boolean }

async function commitNextBatch(job: JobRow, run: ImportRun, seen: Set<string>): Promise<BatchCommitResult | null> {
  return withTransaction(async (conn) => {
    // Row lock serializes workers (retry + continuation) on the same job.
    const [locked] = (await conn.query(`SELECT status, rolled_back FROM data_import_batch_jobs WHERE id = ? FOR UPDATE`, [job.id])) as unknown as [
      { status: string; rolled_back: number }[],
    ]
    if (!locked[0] || locked[0].status !== "running" || locked[0].rolled_back) return null
    const [nextRows] = (await conn.query(
      `SELECT MIN(batch_index) AS b FROM data_import_batch_rows WHERE job_id = ? AND processed = 0`,
      [job.id],
    )) as unknown as [{ b: number | null }[]]
    const batchIndex = nextRows[0]?.b
    if (batchIndex == null) return { imported: 0, failed: 0, skipped: 0, done: true }

    const [staged] = (await conn.query(
      `SELECT id, batch_index, row_number, payload FROM data_import_batch_rows
        WHERE job_id = ? AND batch_index = ? AND processed = 0 ORDER BY row_number`,
      [job.id, batchIndex],
    )) as unknown as [StagedRow[]]
    const prepared = prepareStagedRows(
      run,
      staged.map((r) => ({ rowNumber: Number(r.row_number), raw: parseJson<Record<string, unknown>>(r.payload, {}) })),
      seen,
    )
    const exec = async (sql: string, params: unknown[]) => {
      const [res] = await conn.query(sql, params)
      return res as { insertId?: number }
    }
    let imported = 0
    let failed = 0
    let skipped = 0
    for (let i = 0; i < prepared.length; i++) {
      const row = prepared[i]
      let outcome: string
      let messages: string[] = row.messages
      let insertedId: number | null = null
      if (row.status === "valid") {
        const result = await insertPreparedRow(run, row, Number(job.requested_by ?? 0), exec)
        if (result.ok) {
          outcome = "imported"
          insertedId = result.insertId
          imported++
        } else {
          outcome = "failed"
          messages = [result.message]
          failed++
        }
      } else if (row.status === "duplicate") {
        outcome = "duplicate"
        skipped++
      } else {
        outcome = "invalid"
        failed++
      }
      await conn.query(`UPDATE data_import_batch_rows SET processed = 1, outcome = ?, messages = ?, inserted_id = ? WHERE id = ?`, [
        outcome,
        messages.length ? JSON.stringify(messages.slice(0, 10)) : null,
        insertedId,
        staged[i].id,
      ])
    }
    await conn.query(
      `UPDATE data_import_batch_jobs SET processed_batches = processed_batches + 1,
         imported_rows = imported_rows + ?, failed_rows = failed_rows + ?, skipped_rows = skipped_rows + ? WHERE id = ?`,
      [imported, failed, skipped, job.id],
    )
    await recordEvent(job, "batch_committed", { imported, failed, skipped }, { batchIndex, conn })
    return { imported, failed, skipped, done: false }
  })
}

async function seenFromProcessedRows(job: JobRow, run: ImportRun): Promise<Set<string>> {
  // Imported rows are already in dbFingerprints (loaded from the table). Rebuild
  // in-file fingerprints from previously skipped rows is unnecessary: a later
  // copy of a skipped duplicate is still a duplicate of the imported original.
  void job
  void run
  return new Set<string>()
}

export async function processBatchImport(jobId: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  await ensureBatchSchema()
  const rows = (await query(`SELECT * FROM data_import_batch_jobs WHERE id = ? LIMIT 1`, [jobId])) as JobRow[]
  const job = rows[0]
  if (!job) return { skipped: "job not found" }
  const status = statusOf(job)
  if (job.rolled_back || isTerminalBatchStatus(status)) return { skipped: `job is ${status}` }
  if (status !== "queued" && status !== "running" && status !== "interrupted") return { skipped: `job is ${status}` }

  await query(`UPDATE data_import_batch_jobs SET status = 'running' WHERE id = ? AND status IN ('queued','running','interrupted')`, [job.id])
  const run = await runForJob(job, true)
  const seen = await seenFromProcessedRows(job, run)
  const started = Date.now()
  let batches = 0
  try {
    for (;;) {
      if (signal?.aborted || Date.now() - started > WORKER_TIME_BUDGET_MS) {
        // Hand off to a continuation job; the checkpoint is the processed flag.
        const fresh = await loadJob(job.tenant_id, job.id)
        await enqueue(fresh, `data-import:${job.id}:continue:${fresh.processed_batches}`)
        return { continued: true, batches }
      }
      const result = await commitNextBatch(job, run, seen)
      if (result === null) return { skipped: "job no longer running", batches }
      if (result.done) break
      batches++
    }
  } catch (err) {
    const message = ((err as Error).message || "Batch failed").slice(0, 1000)
    // Only a still-running job becomes resumable; never clobber a concurrent
    // rollback/cancel that already moved it out of `running`.
    await query(`UPDATE data_import_batch_jobs SET status = 'interrupted', error = ? WHERE id = ? AND status = 'running'`, [
      message,
      job.id,
    ])
    await recordEvent(job, "interrupted", { error: message })
    throw err // let the queue retry with backoff; the next attempt resumes from the checkpoint
  }

  const final = await loadJob(job.tenant_id, job.id)
  const finalStatus: BatchImportStatus =
    Number(final.imported_rows) === 0 && Number(final.failed_rows) > 0
      ? "failed"
      : Number(final.failed_rows) > 0 || Number(final.skipped_rows) > 0
        ? "completed_with_errors"
        : "completed"
  await query(`UPDATE data_import_batch_jobs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, [
    finalStatus,
    job.id,
  ])
  await recordEvent(job, "completed", {
    status: finalStatus,
    imported: final.imported_rows,
    failed: final.failed_rows,
    skipped: final.skipped_rows,
  })
  await recordAuditLog({
    action: "data.import",
    entityType: "data_import_batch",
    entityId: String(job.id),
    entityLabel: job.dataset_label,
    result: finalStatus === "failed" ? "failure" : "success",
    after: { imported: final.imported_rows, failed: final.failed_rows, skipped: final.skipped_rows, total: final.total_rows },
  }).catch(() => {})
  return { status: finalStatus, batches, imported: Number(final.imported_rows) }
}

// ---------------------------------------------------------------------------
// Rollback (exact ids, tenant-scoped)
// ---------------------------------------------------------------------------

export async function rollbackBatchImport(tenantId: number | null, actor: ImportActor, jobId: number): Promise<BatchImportJob> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  const status = statusOf(job)
  if (job.rolled_back) throw new BatchImportStateError("This import has already been rolled back")
  if (!job.has_id_pk) throw new BatchImportStateError("Rollback is not supported for this dataset (no numeric id column)")
  if (!canRollback(status, Number(job.imported_rows))) {
    throw new BatchImportStateError("Only finished, interrupted or failed imports with imported rows can be rolled back")
  }
  // Claim the rollback so a concurrent worker/second click cannot race it.
  const claim = (await query(`UPDATE data_import_batch_jobs SET status = 'rolling_back' WHERE id = ? AND status = ? AND rolled_back = 0`, [
    job.id,
    status,
  ])) as { affectedRows?: number }
  if (!claim.affectedRows) throw new BatchImportStateError("The import changed state; refresh and try again")

  let deleted = 0
  let afterId = 0
  try {
    for (;;) {
      const page = (await query(
        `SELECT id, inserted_id FROM data_import_batch_rows WHERE job_id = ? AND outcome = 'imported' AND inserted_id IS NOT NULL AND id > ? ORDER BY id LIMIT ${READ_PAGE}`,
        [job.id, afterId],
      )) as { id: number; inserted_id: number }[]
      if (page.length === 0) break
      afterId = Number(page[page.length - 1].id)
      deleted += await deleteInsertedRows(String(job.target_table), job.tenant_column, job.tenant_id, page.map((r) => Number(r.inserted_id)))
      await query(`UPDATE data_import_batch_rows SET outcome = 'rolled_back' WHERE job_id = ? AND id IN (${page.map(() => "?").join(",")})`, [
        job.id,
        ...page.map((r) => r.id),
      ])
    }
  } catch (err) {
    // Rolled-back rows are marked as they go, so a retry continues where this stopped.
    await query(`UPDATE data_import_batch_jobs SET status = ?, error = ? WHERE id = ?`, [
      status,
      ((err as Error).message || "Rollback failed").slice(0, 1000),
      job.id,
    ])
    throw err
  }
  await query(`UPDATE data_import_batch_jobs SET status = 'rolled_back', rolled_back = 1, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, [job.id])
  await recordEvent(job, "rolled_back", { deleted }, { actorId: actor.userId })
  await recordAuditLog({
    action: "data.import_rollback",
    entityType: "data_import_batch",
    entityId: String(job.id),
    entityLabel: job.dataset_label,
    result: "success",
    before: { importedRows: job.imported_rows },
    after: { deleted },
  }).catch(() => {})
  return project(await loadJob(tenantId, jobId))
}

// ---------------------------------------------------------------------------
// Reads: list, detail, history, row-level error report
// ---------------------------------------------------------------------------

export async function listBatchImports(tenantId: number | null, limit = 50): Promise<BatchImportJob[]> {
  await ensureBatchSchema()
  const scope = tenantScope(tenantId)
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200)
  const rows = (await query(
    `SELECT * FROM data_import_batch_jobs WHERE ${scope.sql} ORDER BY id DESC LIMIT ${safeLimit}`,
    scope.params,
  )) as JobRow[]
  return rows.map(project)
}

export async function getBatchImport(tenantId: number | null, jobId: number): Promise<BatchImportJob> {
  await ensureBatchSchema()
  return project(await loadJob(tenantId, jobId))
}

export async function getBatchImportHistory(tenantId: number | null, jobId: number): Promise<BatchImportEvent[]> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  const rows = (await query(
    `SELECT id, event, batch_index, detail, created_at FROM data_import_batch_events WHERE job_id = ? ORDER BY id DESC LIMIT 500`,
    [job.id],
  )) as { id: number; event: BatchEventType; batch_index: number | null; detail: unknown; created_at: string }[]
  return rows.map((r) => ({
    id: Number(r.id),
    event: r.event,
    batchIndex: r.batch_index == null ? null : Number(r.batch_index),
    detail: parseJson<Record<string, unknown> | null>(r.detail, null),
    createdAt: String(r.created_at),
  }))
}

export type BatchErrorRow = { rowNumber: number; outcome: string; messages: string[] }

export async function getBatchErrorRows(
  tenantId: number | null,
  jobId: number,
  options: { afterRow?: number; limit?: number } = {},
): Promise<{ rows: BatchErrorRow[]; nextAfterRow: number | null }> {
  await ensureBatchSchema()
  const job = await loadJob(tenantId, jobId)
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 500)), READ_PAGE)
  const after = Math.max(0, Math.floor(options.afterRow ?? 0))
  const rows = (await query(
    `SELECT row_number, outcome, messages FROM data_import_batch_rows
      WHERE job_id = ? AND outcome IN ('invalid','duplicate','failed') AND row_number > ?
      ORDER BY row_number LIMIT ${limit}`,
    [job.id, after],
  )) as { row_number: number; outcome: string; messages: string | null }[]
  const mapped = rows.map((r) => ({
    rowNumber: Number(r.row_number),
    outcome: r.outcome,
    messages: parseJson<string[]>(r.messages, []),
  }))
  return { rows: mapped, nextAfterRow: mapped.length === limit ? mapped[mapped.length - 1].rowNumber : null }
}

function csvCell(value: unknown): string {
  const safe = String(neutralizeFormula(value == null ? "" : String(value)) ?? "")
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Streams the full row-level error report as CSV (formula-neutralized). */
export async function streamBatchErrorReport(tenantId: number | null, jobId: number): Promise<ReadableStream<Uint8Array>> {
  await loadJob(tenantId, jobId) // tenant check before streaming anything
  const encoder = new TextEncoder()
  let after = 0
  let headerSent = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true
        controller.enqueue(encoder.encode("row_number,outcome,messages\r\n"))
        return
      }
      const page = await getBatchErrorRows(tenantId, jobId, { afterRow: after, limit: READ_PAGE })
      if (page.rows.length) {
        controller.enqueue(
          encoder.encode(page.rows.map((r) => [r.rowNumber, r.outcome, r.messages.join("; ")].map(csvCell).join(",")).join("\r\n") + "\r\n"),
        )
      }
      if (page.nextAfterRow == null) controller.close()
      else after = page.nextAfterRow
    },
  })
}

export { BATCH_STAGE_CHUNK_MAX }
