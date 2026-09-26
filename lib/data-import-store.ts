import "server-only"
/**
 * Enterprise Data Import store (server).
 * ---------------------------------------------------------------------------
 * Runs the import pipeline against the live database, tenant-scoped and
 * audited:
 *
 *   analyzeImport()  — dry run: map → coerce → validate → detect duplicates →
 *                      preview. Writes nothing.
 *   commitImport()   — insert the valid, non-duplicate rows, capturing each new
 *                      primary key so the batch can be undone. Records an
 *                      immutable import-history job + audit entry.
 *   rollbackImport() — delete the exact rows a completed job inserted (feasible
 *                      when the target table has an auto-increment `id`).
 *
 * Defensive by construction (mirrors lib/data-export-store.ts): every record is
 * filtered to columns that actually exist in the live table, tenant scoping is
 * applied only when the table carries a tenant column, and a missing table or
 * column degrades gracefully instead of crashing. Self-heals its own
 * `data_import_jobs` history table at runtime — no manual migration.
 */

import { query, tableColumns } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { parseSpreadsheetDate } from "@/lib/excel-import"
import { recordAuditLog } from "@/lib/audit-log-store"
import {
  IMPORT_CONFIGS,
  normalizeImportKey,
  buildAliases,
  type ImportConfig,
  type ImportColumn,
} from "@/lib/import-configs"
import { getImportDataset, getPublicImportDataset, dedupeKeysFor } from "@/lib/data-import-catalog"
import {
  IMPORT_ROW_LIMIT,
  importFingerprint,
  type ImportAnalysis,
  type ImportColumnMeta,
  type ImportErrorEntry,
  type ImportJobStatus,
  type ImportJobSummary,
  type ImportPreparedRow,
} from "@/lib/data-import-model"
import { neutralizeFormula } from "@/lib/data-import-batches-model"

const TENANT_COLUMN_CANDIDATES = ["tenant_id", "company_id"]
const PREVIEW_LIMIT = 25
const ISSUE_LIMIT = 500
const DEDUPE_SCAN_LIMIT = 100_000

export type ImportActor = {
  userId: number
  name: string
  email: string
  role: string
}

export type ImportInput = {
  datasetKey: string
  headers: string[]
  rows: Record<string, unknown>[]
  /** target-column → source-header. When omitted, the store auto-maps by alias. */
  mapping?: Record<string, string | null>
  fileName?: string | null
}

// ---------------------------------------------------------------------------
// Schema self-heal
// ---------------------------------------------------------------------------

let ensured = false
async function ensureSchema(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS data_import_jobs (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       tenant_id INT NULL,
       dataset_key VARCHAR(128) NOT NULL,
       dataset_label VARCHAR(191) NOT NULL,
       file_name VARCHAR(255) NULL,
       status VARCHAR(32) NOT NULL,
       total_rows INT NOT NULL DEFAULT 0,
       imported_rows INT NOT NULL DEFAULT 0,
       failed_rows INT NOT NULL DEFAULT 0,
       skipped_rows INT NOT NULL DEFAULT 0,
       error_report LONGTEXT NULL,
       imported_ids LONGTEXT NULL,
       target_table VARCHAR(128) NULL,
       tenant_column VARCHAR(64) NULL,
       rolled_back TINYINT(1) NOT NULL DEFAULT 0,
       requested_by INT NULL,
       requested_by_name VARCHAR(191) NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       finished_at DATETIME NULL,
       KEY idx_import_jobs_tenant (tenant_id, id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

// ---------------------------------------------------------------------------
// Coercion + validation (shared by analyze + commit)
// ---------------------------------------------------------------------------

function parseNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const cleaned = String(value).replace(/[^0-9.\-]/g, "")
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

const TODAY_TOKEN = "@today"

function applyDefault(col: ImportColumn): unknown {
  if (col.default === TODAY_TOKEN) return new Date().toISOString().slice(0, 10)
  return col.default
}

/** Coerce a single raw cell to its stored value. Returns `{ empty, value }`. */
function coerceValue(col: ImportColumn, raw: unknown): { empty: boolean; value: unknown } {
  const isEmpty = raw == null || (typeof raw === "string" && raw.trim() === "")
  if (isEmpty) return { empty: true, value: null }
  if (col.type === "number") {
    const n = parseNumber(raw)
    return { empty: n == null, value: n }
  }
  if (col.type === "date") {
    const d = parseSpreadsheetDate(String(raw))
    return { empty: !d, value: d }
  }
  return { empty: false, value: neutralizeFormula(String(raw).trim()) }
}

/** Auto-map each target column to the best-matching source header by alias. */
function autoMap(config: ImportConfig, headers: string[]): Record<string, string | null> {
  const aliases = buildAliases(config) // target key → normalized alias list
  const normalizedHeaders = headers.map((h) => ({ header: h, norm: normalizeImportKey(h) }))
  const mapping: Record<string, string | null> = {}
  for (const col of config.columns) {
    const wanted = new Set(aliases[col.key] ?? [normalizeImportKey(col.key)])
    const hit = normalizedHeaders.find((h) => wanted.has(h.norm))
    mapping[col.key] = hit ? hit.header : null
  }
  return mapping
}

function columnMeta(config: ImportConfig): ImportColumnMeta[] {
  return config.columns.map((c) => ({
    key: c.key,
    label: c.label,
    type: c.type ?? "string",
    required: Boolean(c.required),
  }))
}

type PreparedRow = {
  row: number
  status: "valid" | "error" | "duplicate"
  messages: string[]
  /** Stored record (only columns that exist + are non-empty or defaulted). */
  record: Record<string, unknown>
  display: Record<string, string>
  fingerprint: string | null
}

type PrepareContext = {
  config: ImportConfig
  mapping: Record<string, string | null>
  existingCols: Set<string>
  dedupeCols: string[]
  dbFingerprints: Set<string>
}

function prepareRow(index: number, raw: Record<string, unknown>, ctx: PrepareContext): PreparedRow {
  const { config, mapping, existingCols, dedupeCols } = ctx
  const messages: string[] = []
  const record: Record<string, unknown> = {}
  const display: Record<string, string> = {}

  for (const col of config.columns) {
    const source = mapping[col.key]
    const rawValue = source != null ? raw[source] : undefined
    const { empty, value } = coerceValue(col, rawValue)

    if (empty) {
      const fallback = applyDefault(col)
      if (fallback != null) {
        if (existingCols.has(col.key.toLowerCase())) record[col.key] = fallback
        display[col.key] = String(fallback)
      } else if (col.required) {
        messages.push(`${col.label} is required`)
      }
      if (col.type === "number" && rawValue != null && String(rawValue).trim() !== "" && value == null) {
        messages.push(`${col.label} is not a valid number`)
      }
      if (col.type === "date" && rawValue != null && String(rawValue).trim() !== "" && value == null) {
        messages.push(`${col.label} is not a valid date`)
      }
      continue
    }

    if (existingCols.has(col.key.toLowerCase())) record[col.key] = value
    display[col.key] = String(value)
  }

  const status: PreparedRow["status"] = messages.length > 0 ? "error" : "valid"

  let fingerprint: string | null = null
  if (status === "valid" && dedupeCols.length > 0) {
    fingerprint = importFingerprint(dedupeCols.map((k) => display[k] ?? ""))
  }

  return { row: index + 2, status, messages, record, display, fingerprint }
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

async function resolveTable(config: ImportConfig): Promise<{ cols: Set<string>; tenantColumn: string | null }> {
  const cols = await tableColumns(config.table)
  const lower = new Set(Array.from(cols).map((c) => c.toLowerCase()))
  const tenantColumn = TENANT_COLUMN_CANDIDATES.find((c) => lower.has(c)) ?? null
  return { cols: lower, tenantColumn }
}

/** Existing dedupe fingerprints already in the table (tenant-scoped when possible). */
async function loadExistingFingerprints(
  config: ImportConfig,
  dedupeCols: string[],
  tenantColumn: string | null,
  tenantId: number | null,
): Promise<Set<string>> {
  const set = new Set<string>()
  if (dedupeCols.length === 0) return set
  const cols = dedupeCols.map((c) => `\`${c}\``).join(", ")
  const where = tenantColumn && tenantId != null ? `WHERE \`${tenantColumn}\` = ?` : ""
  const params = tenantColumn && tenantId != null ? [tenantId] : []
  try {
    const rows = (await query(
      `SELECT ${cols} FROM \`${config.table}\` ${where} LIMIT ${DEDUPE_SCAN_LIMIT}`,
      params,
    )) as Record<string, unknown>[]
    for (const r of rows) set.add(importFingerprint(dedupeCols.map((k) => {
      const value = r[k]
      return typeof value === "string" || typeof value === "number" ? value : null
    })))
  } catch {
    // Missing table/columns → no server-side duplicates to compare against.
  }
  return set
}

function buildPrepareContext(
  config: ImportConfig,
  mapping: Record<string, string | null>,
  existingCols: Set<string>,
  dbFingerprints: Set<string>,
): PrepareContext {
  const dedupeCols = dedupeKeysFor(config).filter((k) => existingCols.has(k.toLowerCase()))
  return { config, mapping, existingCols, dedupeCols, dbFingerprints }
}

/**
 * Run map → coerce → validate → dedupe over every row. Shared by analyze and
 * commit so the preview and the committed result can never disagree.
 */
function runPipeline(rows: Record<string, unknown>[], ctx: PrepareContext): PreparedRow[] {
  const seen = new Set<string>()
  const prepared: PreparedRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = prepareRow(i, rows[i], ctx)
    if (row.status === "valid" && row.fingerprint) {
      if (ctx.dbFingerprints.has(row.fingerprint) || seen.has(row.fingerprint)) {
        row.status = "duplicate"
        row.messages = ["Duplicate of an existing or earlier row"]
      } else {
        seen.add(row.fingerprint)
      }
    }
    prepared.push(row)
  }
  return prepared
}

function clampRows(rows: unknown): { rows: Record<string, unknown>[]; truncated: boolean } {
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
  if (list.length > IMPORT_ROW_LIMIT) return { rows: list.slice(0, IMPORT_ROW_LIMIT), truncated: true }
  return { rows: list, truncated: false }
}

function toIssues(prepared: PreparedRow[]): ImportErrorEntry[] {
  const issues: ImportErrorEntry[] = []
  for (const p of prepared) {
    if (p.status === "valid") continue
    if (issues.length >= ISSUE_LIMIT) break
    issues.push({ row: p.row, type: p.status === "duplicate" ? "duplicate" : "error", messages: p.messages })
  }
  return issues
}

function toPreview(prepared: PreparedRow[]): ImportPreparedRow[] {
  return prepared.slice(0, PREVIEW_LIMIT).map((p) => ({
    row: p.row,
    status: p.status,
    messages: p.messages,
    values: p.display,
  }))
}

// ---------------------------------------------------------------------------
// Analyze (dry run)
// ---------------------------------------------------------------------------

export async function analyzeImport(tenantId: number | null, input: ImportInput): Promise<ImportAnalysis> {
  const config = getImportDataset(input.datasetKey)
  const publicDataset = getPublicImportDataset(input.datasetKey)
  if (!config || !publicDataset) throw new Error("Unknown or unsupported dataset")

  const headers = Array.isArray(input.headers) ? input.headers.map((h) => String(h)) : []
  const { rows, truncated } = clampRows(input.rows)
  const mapping =
    input.mapping && Object.keys(input.mapping).length > 0 ? normalizeMapping(config, input.mapping) : autoMap(config, headers)

  const { cols, tenantColumn } = await resolveTable(config)
  const dbFingerprints = await loadExistingFingerprints(
    config,
    dedupeKeysFor(config).filter((k) => cols.has(k.toLowerCase())),
    tenantColumn,
    tenantId,
  )
  const ctx = buildPrepareContext(config, mapping, cols, dbFingerprints)
  const prepared = runPipeline(rows, ctx)

  const validRows = prepared.filter((p) => p.status === "valid").length
  const errorRows = prepared.filter((p) => p.status === "error").length
  const duplicateRows = prepared.filter((p) => p.status === "duplicate").length
  const unmappedRequired = config.columns
    .filter((c) => c.required && !mapping[c.key])
    .map((c) => c.key)

  return {
    datasetKey: input.datasetKey,
    datasetLabel: `${publicDataset.label} · ${publicDataset.module}`,
    mapping,
    columns: columnMeta(config),
    headers,
    totalRows: rows.length,
    validRows,
    errorRows,
    duplicateRows,
    unmappedRequired,
    dedupeKeys: ctx.dedupeCols,
    issues: toIssues(prepared),
    preview: toPreview(prepared),
    canImport: validRows > 0 && unmappedRequired.length === 0,
    truncated,
  }
}

/** Keep only target keys the config actually declares. */
function normalizeMapping(
  config: ImportConfig,
  mapping: Record<string, string | null>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const col of config.columns) {
    const v = mapping[col.key]
    out[col.key] = v && String(v).trim() !== "" ? String(v) : null
  }
  return out
}

// ---------------------------------------------------------------------------
// Reusable pipeline for the queued batch importer
// (lib/data-import-batches-store.ts). Same map → coerce → validate → dedupe →
// insert rules as analyze/commit, but driven batch by batch.
// ---------------------------------------------------------------------------

export type ImportRunRow = PreparedRow

export type ImportRun = {
  config: ImportConfig
  datasetLabel: string
  mapping: Record<string, string | null>
  cols: Set<string>
  tenantColumn: string | null
  tenantId: number | null
  ctx: PrepareContext
  unmappedRequired: string[]
  hasIdPk: boolean
  createdByColumn: string | null
  mintId: ((record: Record<string, unknown>) => Promise<void>) | null
}

export async function prepareImportRun(
  tenantId: number | null,
  datasetKey: string,
  headers: string[],
  mapping: Record<string, string | null> | null | undefined,
  options: { withIdMinter?: boolean } = {},
): Promise<ImportRun> {
  const config = getImportDataset(datasetKey)
  const publicDataset = getPublicImportDataset(datasetKey)
  if (!config || !publicDataset) throw new Error("Unknown or unsupported dataset")
  const resolvedMapping =
    mapping && Object.keys(mapping).length > 0 ? normalizeMapping(config, mapping) : autoMap(config, headers)
  const { cols, tenantColumn } = await resolveTable(config)
  const dbFingerprints = await loadExistingFingerprints(
    config,
    dedupeKeysFor(config).filter((k) => cols.has(k.toLowerCase())),
    tenantColumn,
    tenantId,
  )
  const createdByColumn = config.createdBy === null ? null : config.createdBy ?? "created_by"
  return {
    config,
    datasetLabel: `${publicDataset.label} · ${publicDataset.module}`,
    mapping: resolvedMapping,
    cols,
    tenantColumn,
    tenantId,
    ctx: buildPrepareContext(config, resolvedMapping, cols, dbFingerprints),
    unmappedRequired: config.columns.filter((c) => c.required && !resolvedMapping[c.key]).map((c) => c.key),
    hasIdPk: cols.has("id"),
    createdByColumn: createdByColumn != null && cols.has(createdByColumn.toLowerCase()) ? createdByColumn : null,
    mintId: options.withIdMinter ? await makeIdMinter(config, tenantColumn, tenantId) : null,
  }
}

/**
 * Prepare staged rows. `seen` carries in-file duplicate fingerprints ACROSS
 * batches so a duplicate ID in batch 7 of a row in batch 1 is still caught.
 * `rowNumber` is the 1-based spreadsheet row (header = 1).
 */
export function prepareStagedRows(
  run: ImportRun,
  rows: { rowNumber: number; raw: Record<string, unknown> }[],
  seen: Set<string>,
): ImportRunRow[] {
  const out: ImportRunRow[] = []
  for (const { rowNumber, raw } of rows) {
    const row = prepareRow(rowNumber - 2, raw, run.ctx)
    if (row.status === "valid" && row.fingerprint) {
      if (run.ctx.dbFingerprints.has(row.fingerprint) || seen.has(row.fingerprint)) {
        row.status = "duplicate"
        row.messages = ["Duplicate of an existing or earlier row"]
      } else {
        seen.add(row.fingerprint)
      }
    }
    out.push(row)
  }
  return out
}

type Exec = (sql: string, params: unknown[]) => Promise<{ insertId?: number } | unknown>

/** Insert one prepared valid row; tenant + creator are forced server-side. */
export async function insertPreparedRow(
  run: ImportRun,
  row: ImportRunRow,
  actorId: number,
  exec: Exec = (sql, params) => query(sql, params as any[]),
): Promise<{ ok: true; insertId: number | null } | { ok: false; message: string }> {
  const record = { ...row.record }
  if (run.tenantColumn && run.tenantId != null) record[run.tenantColumn] = run.tenantId
  if (run.createdByColumn) record[run.createdByColumn] = actorId
  try {
    if (run.mintId) await run.mintId(record)
    const keys = Object.keys(record).filter((k) => run.cols.has(k.toLowerCase()))
    if (keys.length === 0) throw new Error("No mappable columns for this row")
    const result = (await exec(
      `INSERT INTO \`${run.config.table}\` (${keys.map((k) => `\`${k}\``).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((k) => record[k]),
    )) as { insertId?: number } | undefined
    if (row.fingerprint) run.ctx.dbFingerprints.add(row.fingerprint)
    return { ok: true, insertId: run.hasIdPk && result?.insertId ? Number(result.insertId) : null }
  } catch (err) {
    return { ok: false, message: ((err as Error).message || "Insert failed").slice(0, 500) }
  }
}

/** Delete exact inserted ids from the run's table, tenant-scoped. */
export async function deleteInsertedRows(
  table: string,
  tenantColumn: string | null,
  tenantId: number | null,
  ids: number[],
): Promise<number> {
  let deleted = 0
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).filter((n) => Number.isFinite(n))
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => "?").join(", ")
    const scoped = tenantColumn && tenantId != null
    const res = (await query(
      `DELETE FROM \`${table}\` WHERE ${scoped ? `\`${tenantColumn}\` = ? AND ` : ""}id IN (${placeholders})`,
      scoped ? [tenantId, ...chunk] : chunk,
    )) as { affectedRows?: number }
    deleted += Number(res?.affectedRows ?? 0)
  }
  return deleted
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** Mint an id for a row per the config's id strategy, mirroring the module importer. */
async function makeIdMinter(
  config: ImportConfig,
  tenantColumn: string | null,
  tenantId: number | null,
): Promise<((record: Record<string, unknown>) => Promise<void>) | null> {
  if (!config.idColumn || !config.id) return null
  const idColumn = config.idColumn
  const spec = config.id

  if (spec.strategy === "sequence") {
    return async (record) => {
      if (record[idColumn]) return // honor a hand-supplied id
      record[idColumn] = await nextRecordId(spec.prefix, { allowCustom: spec.allowCustom })
    }
  }

  // maxSubstring: seed the counter from the current table max, then increment.
  const where = tenantColumn && tenantId != null ? `WHERE \`${tenantColumn}\` = ?` : ""
  const params = tenantColumn && tenantId != null ? [tenantId] : []
  let counter = 0
  try {
    const rows = (await query(
      `SELECT \`${idColumn}\` AS v FROM \`${config.table}\` ${where}`,
      params,
    )) as { v: string }[]
    for (const r of rows) {
      const n = Number(String(r.v ?? "").replace(/[^0-9]/g, ""))
      if (Number.isFinite(n) && n > counter) counter = n
    }
  } catch {
    // fall through with counter = 0
  }
  const prefix = spec.prefix ?? ""
  const pad = spec.digits ?? 4
  return async (record) => {
    if (record[idColumn]) return
    counter += 1
    record[idColumn] = `${prefix}${String(counter).padStart(pad, "0")}`
  }
}

export async function commitImport(
  tenantId: number | null,
  actor: ImportActor,
  input: ImportInput,
): Promise<ImportJobSummary> {
  await ensureSchema()
  const config = getImportDataset(input.datasetKey)
  const publicDataset = getPublicImportDataset(input.datasetKey)
  if (!config || !publicDataset) throw new Error("Unknown or unsupported dataset")

  const datasetLabel = `${publicDataset.label} · ${publicDataset.module}`
  const headers = Array.isArray(input.headers) ? input.headers.map((h) => String(h)) : []
  const { rows } = clampRows(input.rows)
  const mapping =
    input.mapping && Object.keys(input.mapping).length > 0 ? normalizeMapping(config, input.mapping) : autoMap(config, headers)

  const { cols, tenantColumn } = await resolveTable(config)
  const unmappedRequired = config.columns.filter((c) => c.required && !mapping[c.key])
  if (unmappedRequired.length > 0) {
    throw new Error(`Map required column(s): ${unmappedRequired.map((c) => c.label).join(", ")}`)
  }

  const dbFingerprints = await loadExistingFingerprints(
    config,
    dedupeKeysFor(config).filter((k) => cols.has(k.toLowerCase())),
    tenantColumn,
    tenantId,
  )
  const ctx = buildPrepareContext(config, mapping, cols, dbFingerprints)
  const prepared = runPipeline(rows, ctx)

  const createdByColumn = config.createdBy === null ? null : config.createdBy ?? "created_by"
  const hasCreatedBy = createdByColumn != null && cols.has(createdByColumn.toLowerCase())
  const hasIdPk = cols.has("id")
  const mintId = await makeIdMinter(config, tenantColumn, tenantId)

  const importedIds: number[] = []
  const issues: ImportErrorEntry[] = toIssues(prepared) // errors + duplicates skipped up-front
  let imported = 0
  let failed = 0
  const skipped = prepared.filter((p) => p.status !== "valid").length

  for (const p of prepared) {
    if (p.status !== "valid") continue
    const record = { ...p.record }
    if (tenantColumn && tenantId != null) record[tenantColumn] = tenantId
    if (hasCreatedBy && createdByColumn) record[createdByColumn] = actor.userId
    try {
      if (mintId) await mintId(record)
      const keys = Object.keys(record).filter((k) => cols.has(k.toLowerCase()))
      if (keys.length === 0) throw new Error("No mappable columns for this row")
      const placeholders = keys.map(() => "?").join(", ")
      const columnList = keys.map((k) => `\`${k}\``).join(", ")
      const values = keys.map((k) => record[k])
      const result = (await query(
        `INSERT INTO \`${config.table}\` (${columnList}) VALUES (${placeholders})`,
        values,
      )) as { insertId?: number; affectedRows?: number }
      imported += 1
      if (hasIdPk && result?.insertId) importedIds.push(Number(result.insertId))
    } catch (err) {
      failed += 1
      if (issues.length < ISSUE_LIMIT) {
        issues.push({ row: p.row, type: "error", messages: [(err as Error).message || "Insert failed"] })
      }
    }
  }

  // Rollback is only feasible when EVERY inserted row was captured by an
  // auto-increment `id` — otherwise we can't identify the exact rows to remove.
  const rollbackable = hasIdPk && imported > 0 && importedIds.length === imported
  const status: ImportJobStatus =
    imported === 0 ? "failed" : failed > 0 || issues.length > 0 ? "completed_with_errors" : "completed"

  const res = (await query(
    `INSERT INTO data_import_jobs
       (tenant_id, dataset_key, dataset_label, file_name, status, total_rows, imported_rows,
        failed_rows, skipped_rows, error_report, imported_ids, target_table, tenant_column,
        requested_by, requested_by_name, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      tenantId,
      input.datasetKey,
      datasetLabel,
      input.fileName ?? null,
      status,
      rows.length,
      imported,
      failed,
      skipped,
      JSON.stringify(issues),
      rollbackable ? JSON.stringify(importedIds) : null,
      config.table,
      tenantColumn,
      actor.userId,
      actor.name,
    ],
  )) as { insertId?: number }
  const jobId = Number(res?.insertId ?? 0)

  await recordAuditLog({
    action: "data.import",
    entityType: "data_import",
    entityId: String(jobId),
    entityLabel: datasetLabel,
    result: status === "failed" ? "failure" : "success",
    after: { imported, failed, skipped, total: rows.length, fileName: input.fileName ?? null },
  }).catch(() => {})

  return (await getImportJob(tenantId, jobId)) ?? {
    id: jobId,
    datasetKey: input.datasetKey,
    datasetLabel,
    fileName: input.fileName ?? null,
    status,
    totalRows: rows.length,
    importedRows: imported,
    failedRows: failed,
    skippedRows: skipped,
    errorCount: issues.length,
    rolledBack: false,
    rollbackable,
    requestedByName: actor.name,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export async function rollbackImport(
  tenantId: number | null,
  actor: ImportActor,
  jobId: number,
): Promise<ImportJobSummary> {
  await ensureSchema()
  const rows = (await query(
    `SELECT * FROM data_import_jobs WHERE id = ? AND ${tenantScopeSql(tenantId)} LIMIT 1`,
    tenantId == null ? [jobId] : [jobId, tenantId],
  )) as any[]
  const job = rows[0]
  if (!job) throw new Error("Import job not found")
  if (job.rolled_back) throw new Error("This import was already rolled back")
  if (!job.imported_ids) throw new Error("This import cannot be rolled back")

  const ids: number[] = JSON.parse(job.imported_ids)
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("This import cannot be rolled back")

  const table = String(job.target_table)
  const tenantColumn: string | null = job.tenant_column ?? null
  let deleted = 0
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).filter((n) => Number.isFinite(n))
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => "?").join(", ")
    const where =
      tenantColumn && job.tenant_id != null ? `\`${tenantColumn}\` = ? AND id IN (${placeholders})` : `id IN (${placeholders})`
    const params = tenantColumn && job.tenant_id != null ? [job.tenant_id, ...chunk] : chunk
    const res = (await query(`DELETE FROM \`${table}\` WHERE ${where}`, params)) as { affectedRows?: number }
    deleted += Number(res?.affectedRows ?? 0)
  }

  await query(
    `UPDATE data_import_jobs SET status = 'rolled_back', rolled_back = 1, imported_ids = NULL WHERE id = ?`,
    [jobId],
  )

  await recordAuditLog({
    action: "data.import_rollback",
    entityType: "data_import",
    entityId: String(jobId),
    entityLabel: String(job.dataset_label),
    result: "success",
    before: { importedRows: job.imported_rows },
    after: { deleted },
  }).catch(() => {})

  const updated = await getImportJob(tenantId, jobId)
  if (!updated) throw new Error("Import job not found")
  return updated
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function tenantScopeSql(tenantId: number | null): string {
  return tenantId == null ? "tenant_id IS NULL" : "tenant_id = ?"
}

function mapJobRow(row: any): ImportJobSummary {
  const status = String(row.status) as ImportJobStatus
  return {
    id: Number(row.id),
    datasetKey: String(row.dataset_key),
    datasetLabel: String(row.dataset_label),
    fileName: row.file_name ?? null,
    status,
    totalRows: Number(row.total_rows ?? 0),
    importedRows: Number(row.imported_rows ?? 0),
    failedRows: Number(row.failed_rows ?? 0),
    skippedRows: Number(row.skipped_rows ?? 0),
    errorCount: safeCount(row.error_report),
    rolledBack: Boolean(row.rolled_back),
    rollbackable: !row.rolled_back && Boolean(row.imported_ids),
    requestedByName: row.requested_by_name ?? null,
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  }
}

function safeCount(errorReport: unknown): number {
  if (!errorReport) return 0
  try {
    const parsed = JSON.parse(String(errorReport))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

export async function listImportJobs(tenantId: number | null): Promise<ImportJobSummary[]> {
  await ensureSchema()
  const rows = (await query(
    `SELECT * FROM data_import_jobs WHERE ${tenantScopeSql(tenantId)} ORDER BY id DESC LIMIT 100`,
    tenantId == null ? [] : [tenantId],
  )) as any[]
  return rows.map(mapJobRow)
}

export async function getImportJob(tenantId: number | null, jobId: number): Promise<ImportJobSummary | null> {
  await ensureSchema()
  const rows = (await query(
    `SELECT * FROM data_import_jobs WHERE id = ? AND ${tenantScopeSql(tenantId)} LIMIT 1`,
    tenantId == null ? [jobId] : [jobId, tenantId],
  )) as any[]
  return rows[0] ? mapJobRow(rows[0]) : null
}

/** The stored issue list for a job, for the downloadable error report. */
export async function getImportJobIssues(
  tenantId: number | null,
  jobId: number,
): Promise<{ label: string; issues: ImportErrorEntry[] } | null> {
  await ensureSchema()
  const rows = (await query(
    `SELECT dataset_label, error_report FROM data_import_jobs WHERE id = ? AND ${tenantScopeSql(tenantId)} LIMIT 1`,
    tenantId == null ? [jobId] : [jobId, tenantId],
  )) as any[]
  if (!rows[0]) return null
  let issues: ImportErrorEntry[] = []
  try {
    const parsed = JSON.parse(String(rows[0].error_report ?? "[]"))
    if (Array.isArray(parsed)) issues = parsed
  } catch {
    issues = []
  }
  return { label: String(rows[0].dataset_label), issues }
}

export { IMPORT_CONFIGS }
