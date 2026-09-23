import "server-only"
/**
 * Tenant Data Export (server store + job execution).
 * ---------------------------------------------------------------------------
 * Replaces the frontend-only localStorage placeholder (lib/governance-store.ts)
 * for the Export Center with a real, tenant-scoped, audited, DB-backed export
 * pipeline that respects data classification.
 *
 * A job binds a SCOPE (one catalog dataset, or the whole tenant) + a FORMAT and
 * produces a single stored ARTIFACT. Execution:
 *
 *   1. Resolve each dataset's physical table + tenant/order columns against the
 *      LIVE schema, skipping datasets whose table is absent.
 *   2. Query rows tenant-scoped (a job can never read another tenant's data)
 *      and capped at MAX_ROWS_PER_DATASET.
 * 3. Redact every field the acting role may not export via the
 *      clearance matrix (enforceExportClassification).
 *   4. Serialize to CSV / Excel / JSON / PDF and seal the bytes into the job
 *      row with a content type, filename, byte size and an EXPIRY.
 *   5. Mint an HMAC download token bound to the job + tenant + a per-job salt,
 *      and write an immutable AUDIT entry.
 *
 * Schedules re-run a saved scope on a cadence; the cron sweep enqueues + runs
 * every due schedule. Self-heals its schema at runtime (same pattern as
 * lib/data-classification.ts) so existing databases converge with no manual
 * migration.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { query, tableColumns } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { classifiedFieldsFor, enforceExportClassification, getClearanceMatrix } from "@/lib/data-classification"
import type { TenantRole } from "@/lib/role-model"
import {
  EXPORT_CATALOG,
  type ExportDataset,
  getExportDataset,
  resolveExistingColumn,
} from "@/lib/data-export-catalog"
import {
  type ExportFormat,
  type ExportFrequency,
  type ExportStatus,
  buildTable,
  clampExportTtl,
  computeNextExportRun,
  exportContentType,
  exportFileName,
  FULL_TENANT_EXPORT_KEY,
  isExportExpired,
  isFullTenantScope,
  isScheduleDue,
  serializeCsv,
  serializeJson,
  toExportFormat,
  toExportFrequency,
} from "@/lib/data-export-model"

/** Safety cap on rows pulled per dataset in one export. */
const MAX_ROWS_PER_DATASET = 50_000

export type Actor = { userId: number; name?: string | null; email?: string | null; role: TenantRole }

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExportJob = {
  id: number
  tenantId: number | null
  datasetKey: string
  scopeLabel: string
  format: ExportFormat
  status: ExportStatus
  rowCount: number
  redactedFields: string[]
  fileName: string | null
  byteSize: number
  triggerSource: "manual" | "scheduler"
  scheduleId: number | null
  requestedByName: string | null
  error: string | null
  expiresAt: string | null
  createdAt: string
  finishedAt: string | null
}

export type ExportSchedule = {
  id: number
  tenantId: number | null
  datasetKey: string
  scopeLabel: string
  format: ExportFormat
  frequency: ExportFrequency
  status: "active" | "paused"
  lastRunAt: string | null
  nextRunAt: string | null
  createdByName: string | null
  createdAt: string
}

type JobRow = {
  id: number
  tenant_id: number | null
  dataset_key: string
  scope_label: string
  format: string
  status: string
  row_count: number
  redacted_fields: string | null
  file_name: string | null
  content_type: string | null
  byte_size: number
  trigger_source: string
  schedule_id: number | null
  requested_by: number | null
  requested_by_name: string | null
  error: string | null
  token_salt: string | null
  expires_at: string | null
  created_at: string
  finished_at: string | null
}

type ScheduleRow = {
  id: number
  tenant_id: number | null
  dataset_key: string
  scope_label: string
  format: string
  frequency: string
  status: string
  last_run_at: string | null
  next_run_at: string | null
  created_by: number | null
  created_by_name: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`data_export_jobs\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`dataset_key\` VARCHAR(120) NOT NULL,
      \`scope_label\` VARCHAR(190) NOT NULL,
      \`format\` VARCHAR(12) NOT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'queued',
      \`row_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`redacted_fields\` TEXT DEFAULT NULL,
      \`file_name\` VARCHAR(190) DEFAULT NULL,
      \`content_type\` VARCHAR(120) DEFAULT NULL,
      \`byte_size\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`artifact\` LONGBLOB DEFAULT NULL,
      \`token_salt\` VARCHAR(48) DEFAULT NULL,
      \`trigger_source\` VARCHAR(16) NOT NULL DEFAULT 'manual',
      \`schedule_id\` INT UNSIGNED DEFAULT NULL,
      \`requested_by\` INT UNSIGNED DEFAULT NULL,
      \`error\` TEXT DEFAULT NULL,
      \`expires_at\` TIMESTAMP NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`finished_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_export_job_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_export_job_schedule\` (\`schedule_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`data_export_schedules\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`dataset_key\` VARCHAR(120) NOT NULL,
      \`scope_label\` VARCHAR(190) NOT NULL,
      \`format\` VARCHAR(12) NOT NULL,
      \`frequency\` VARCHAR(12) NOT NULL DEFAULT 'weekly',
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
      \`last_run_at\` TIMESTAMP NULL DEFAULT NULL,
      \`next_run_at\` TIMESTAMP NULL DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_export_schedule_tenant\` (\`tenant_id\`),
      KEY \`idx_export_schedule_due\` (\`status\`, \`next_run_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
}

function ensureTables(): Promise<void> {
  if (!ensured)
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  return ensured
}

// ---------------------------------------------------------------------------
// Download token (HMAC, bound to job + tenant + per-job salt + expiry)
// ---------------------------------------------------------------------------

function signingSecret(): string {
  return process.env.STORAGE_URL_SIGNING_SECRET || process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function computeToken(jobId: number, tenantId: number | null, salt: string, exp: number): string {
  return b64url(
    createHmac("sha256", signingSecret()).update(`${jobId}\n${tenantId ?? "null"}\n${salt}\n${exp}`).digest(),
  )
}

/** Verify a download token against the job's stored salt, tenant and expiry. */
export function verifyExportToken(
  job: { id: number; tenantId: number | null; tokenSalt: string | null; expiresAt: string | null },
  exp: string | null,
  sig: string | null,
): { valid: boolean; reason?: string } {
  if (!job.tokenSalt) return { valid: false, reason: "revoked" }
  if (!exp || !sig) return { valid: false, reason: "malformed" }
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum <= 0) return { valid: false, reason: "malformed" }
  if (Math.floor(Date.now() / 1000) > expNum) return { valid: false, reason: "expired" }
  if (isExportExpired(job.expiresAt)) return { valid: false, reason: "expired" }
  const expected = computeToken(job.id, job.tenantId, job.tokenSalt, expNum)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad-signature" }
  return { valid: true }
}

/** Build the relative, signed, expiring download path for a completed job. */
export function buildDownloadPath(job: {
  id: number
  tenantId: number | null
  tokenSalt: string | null
  expiresAt: string | null
}): string | null {
  if (!job.tokenSalt) return null
  const expiryMs = job.expiresAt ? new Date(job.expiresAt).getTime() : Date.now() + clampExportTtl(undefined) * 1000
  const exp = Math.floor(expiryMs / 1000)
  const sig = computeToken(job.id, job.tenantId, job.tokenSalt, exp)
  return `/api/admin/governance/export/${job.id}/download?exp=${exp}&sig=${encodeURIComponent(sig)}`
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toPublicJob(row: JobRow): ExportJob {
  let redacted: string[] = []
  if (row.redacted_fields) {
    try {
      const parsed = JSON.parse(row.redacted_fields)
      if (Array.isArray(parsed)) redacted = parsed.map(String)
    } catch {
      redacted = []
    }
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    datasetKey: row.dataset_key,
    scopeLabel: row.scope_label,
    format: toExportFormat(row.format),
    status: (row.status as ExportStatus) ?? "queued",
    rowCount: row.row_count,
    redactedFields: redacted,
    fileName: row.file_name,
    byteSize: row.byte_size,
    triggerSource: row.trigger_source === "scheduler" ? "scheduler" : "manual",
    scheduleId: row.schedule_id,
    requestedByName: row.requested_by_name,
    error: row.error,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function toPublicSchedule(row: ScheduleRow): ExportSchedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    datasetKey: row.dataset_key,
    scopeLabel: row.scope_label,
    format: toExportFormat(row.format),
    frequency: toExportFrequency(row.frequency),
    status: row.status === "paused" ? "paused" : "active",
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

function resolveScope(datasetKey: string): { label: string; datasets: ExportDataset[] } {
  if (isFullTenantScope(datasetKey)) {
    return { label: "Full tenant export", datasets: EXPORT_CATALOG.slice() }
  }
  const dataset = getExportDataset(datasetKey)
  if (!dataset) throw new Error("Unknown export dataset")
  return { label: dataset.label, datasets: [dataset] }
}

// ---------------------------------------------------------------------------
// Job CRUD + execution
// ---------------------------------------------------------------------------

export async function listExportJobs(tenantId: number | null, limit = 100): Promise<ExportJob[]> {
  await ensureTables()
  const rows = await query<JobRow[]>(
    `SELECT j.id, j.tenant_id, j.dataset_key, j.scope_label, j.format, j.status, j.row_count,
            j.redacted_fields, j.file_name, j.content_type, j.byte_size, j.trigger_source, j.schedule_id,
            j.requested_by, u.name AS requested_by_name, j.error, j.token_salt, j.expires_at, j.created_at, j.finished_at
       FROM data_export_jobs j
       LEFT JOIN users u ON u.id = j.requested_by
      WHERE j.tenant_id <=> ?
      ORDER BY j.created_at DESC
      LIMIT ?`,
    [tenantId, limit],
  )
  return rows.map(toPublicJob)
}

async function loadJobRow(tenantId: number | null, id: number): Promise<JobRow | null> {
  const rows = await query<JobRow[]>(
    `SELECT j.id, j.tenant_id, j.dataset_key, j.scope_label, j.format, j.status, j.row_count,
            j.redacted_fields, j.file_name, j.content_type, j.byte_size, j.trigger_source, j.schedule_id,
            j.requested_by, u.name AS requested_by_name, j.error, j.token_salt, j.expires_at, j.created_at, j.finished_at
       FROM data_export_jobs j
       LEFT JOIN users u ON u.id = j.requested_by
      WHERE j.id = ? AND j.tenant_id <=> ?
      LIMIT 1`,
    [id, tenantId],
  )
  return rows[0] ?? null
}

export async function getExportJob(tenantId: number | null, id: number): Promise<ExportJob | null> {
  await ensureTables()
  const row = await loadJobRow(tenantId, id)
  return row ? toPublicJob(row) : null
}

/** The public job plus the signed download path (only when downloadable). */
export async function getExportJobWithLink(
  tenantId: number | null,
  id: number,
): Promise<(ExportJob & { downloadPath: string | null }) | null> {
  await ensureTables()
  const row = await loadJobRow(tenantId, id)
  if (!row) return null
  const job = toPublicJob(row)
  const downloadable = job.status === "completed" && !isExportExpired(job.expiresAt)
  const downloadPath = downloadable
    ? buildDownloadPath({ id: row.id, tenantId: row.tenant_id, tokenSalt: row.token_salt, expiresAt: row.expires_at })
    : null
  return { ...job, downloadPath }
}

/**
 * The raw artifact for the download route. Re-checks tenant + expiry and
 * returns null when the job is missing, not this tenant's, unfinished, or
 * expired. The caller has ALSO verified the signed token and the session.
 */
export async function getExportArtifact(
  tenantId: number | null,
  id: number,
): Promise<{ bytes: Buffer; contentType: string; fileName: string } | null> {
  await ensureTables()
  const rows = await query<(JobRow & { artifact: Buffer | null })[]>(
    `SELECT id, tenant_id, status, file_name, content_type, expires_at, artifact
       FROM data_export_jobs WHERE id = ? AND tenant_id <=> ? LIMIT 1`,
    [id, tenantId],
  )
  const row = rows[0]
  if (!row || row.status !== "completed" || !row.artifact) return null
  if (isExportExpired(row.expires_at)) return null
  return {
    bytes: Buffer.isBuffer(row.artifact) ? row.artifact : Buffer.from(row.artifact as unknown as ArrayBuffer),
    contentType: row.content_type || "application/octet-stream",
    fileName: row.file_name || `export-${id}`,
  }
}

/**
 * Full download resolution for the secure download route: re-checks tenant
 * ownership, verifies the signed token against the job's salt + expiry, and
 * returns the artifact bytes only when everything holds. Keeps the token salt
 * and raw bytes entirely inside the store.
 */
export async function resolveExportDownload(
  tenantId: number | null,
  id: number,
  exp: string | null,
  sig: string | null,
): Promise<
  | { ok: true; bytes: Buffer; contentType: string; fileName: string }
  | { ok: false; status: number; reason: string }
> {
  await ensureTables()
  const rows = await query<(JobRow & { artifact: Buffer | null })[]>(
    `SELECT id, tenant_id, status, file_name, content_type, token_salt, expires_at, artifact
       FROM data_export_jobs WHERE id = ? AND tenant_id <=> ? LIMIT 1`,
    [id, tenantId],
  )
  const row = rows[0]
  if (!row) return { ok: false, status: 404, reason: "Not found" }
  const check = verifyExportToken(
    { id: row.id, tenantId: row.tenant_id, tokenSalt: row.token_salt, expiresAt: row.expires_at },
    exp,
    sig,
  )
  if (!check.valid) {
    const status = check.reason === "expired" ? 410 : 403
    return { ok: false, status, reason: check.reason ?? "Invalid token" }
  }
  if (row.status !== "completed" || !row.artifact) return { ok: false, status: 409, reason: "Export not ready" }
  return {
    ok: true,
    bytes: Buffer.isBuffer(row.artifact) ? row.artifact : Buffer.from(row.artifact as unknown as ArrayBuffer),
    contentType: row.content_type || "application/octet-stream",
    fileName: row.file_name || `export-${id}`,
  }
}

export type CreateExportInput = {
  datasetKey: string
  format: unknown
  triggerSource?: "manual" | "scheduler"
  scheduleId?: number | null
  ttlSeconds?: number
}

/**
 * Create AND run an export job synchronously (datasets are row-capped). Returns
 * the finished job. Any failure is captured on the job row rather than thrown,
 * so the UI always has a record to show.
 */
export async function createAndRunExport(
  tenantId: number | null,
  input: CreateExportInput,
  actor: Actor,
): Promise<ExportJob> {
  await ensureTables()
  const scope = resolveScope(input.datasetKey)
  const format = toExportFormat(input.format)
  const triggerSource = input.triggerSource === "scheduler" ? "scheduler" : "manual"
  const salt = randomBytes(18).toString("hex")
  const ttl = clampExportTtl(input.ttlSeconds)
  const expiresAt = new Date(Date.now() + ttl * 1000)

  const res = await query<{ insertId: number }>(
    `INSERT INTO data_export_jobs
       (tenant_id, dataset_key, scope_label, format, status, trigger_source, schedule_id, requested_by, token_salt, expires_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.datasetKey,
      scope.label,
      format,
      triggerSource,
      input.scheduleId ?? null,
      actor.userId,
      salt,
      expiresAt,
    ],
  )
  const jobId = (res as any).insertId as number

  try {
    const { bytes, rowCount, redacted, fileName, contentType } = await renderExport(
      tenantId,
      scope.label,
      scope.datasets,
      format,
      actor.role,
    )
    if (bytes.length > 16 * 1024 * 1024 * 0.9) {
      // Stay safely under a default 16MB max_allowed_packet.
      throw new Error("Export exceeds the maximum artifact size; narrow the scope or use CSV/JSON")
    }
    await query(
      `UPDATE data_export_jobs
          SET status = 'completed', row_count = ?, redacted_fields = ?, file_name = ?, content_type = ?,
              byte_size = ?, artifact = ?, finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [rowCount, JSON.stringify(redacted), fileName, contentType, bytes.length, bytes, jobId],
    )
    await recordAuditLog({
      action: "data_export.complete",
      entityType: "data_export_job",
      entityId: jobId,
      entityLabel: `${scope.label} (${format.toUpperCase()})`,
      after: {
        datasetKey: input.datasetKey,
        format,
        rowCount,
        redactedFields: redacted,
        byteSize: bytes.length,
        triggerSource,
        expiresAt: expiresAt.toISOString(),
      },
      context: {
        tenantId,
        actorUserId: actor.userId,
        actorName: actor.name ?? null,
        actorEmail: actor.email ?? null,
        actorRole: actor.role,
      },
    })
  } catch (err) {
    const message = (err as Error).message || "Export failed"
    await query(`UPDATE data_export_jobs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      message.slice(0, 500),
      jobId,
    ])
    await recordAuditLog({
      action: "data_export.fail",
      entityType: "data_export_job",
      entityId: jobId,
      entityLabel: `${scope.label} (${format.toUpperCase()})`,
      after: { datasetKey: input.datasetKey, format, error: message.slice(0, 500), triggerSource },
      context: {
        tenantId,
        actorUserId: actor.userId,
        actorName: actor.name ?? null,
        actorEmail: actor.email ?? null,
        actorRole: actor.role,
      },
    })
  }

  const row = await loadJobRow(tenantId, jobId)
  return toPublicJob(row as JobRow)
}

// ---------------------------------------------------------------------------
// Rendering — query, classify-redact, serialize
// ---------------------------------------------------------------------------

type RenderedDataset = { label: string; columns: string[]; rows: Record<string, unknown>[]; redacted: string[] }

async function collectDataset(
  tenantId: number | null,
  dataset: ExportDataset,
  role: TenantRole,
  matrix: Awaited<ReturnType<typeof getClearanceMatrix>>,
): Promise<RenderedDataset> {
  const columns = await tableColumns(dataset.table).catch(() => new Set<string>())
  if (columns.size === 0) return { label: dataset.label, columns: [], rows: [], redacted: [] }

  const tenantCol = resolveExistingColumn(dataset.tenantColumns, columns)
  // If the table is tenant-scoped in reality but we can't find its tenant
  // column, refuse to read it for a specific tenant — never risk a cross-tenant
  // leak. A null tenant context (single-tenant / platform) may read all rows.
  if (tenantId != null && !tenantCol) return { label: dataset.label, columns: [], rows: [], redacted: [] }

  const orderCol = resolveExistingColumn(dataset.orderColumns, columns)
  const where = tenantCol ? `WHERE \`${tenantCol}\` = ?` : ""
  const orderBy = orderCol ? `ORDER BY \`${orderCol}\`` : ""
  const params = tenantCol ? [tenantId] : []

  const rows = await query<Record<string, unknown>[]>(
    `SELECT * FROM \`${dataset.table}\` ${where} ${orderBy} LIMIT ${MAX_ROWS_PER_DATASET}`,
    params,
  )

  const fields = await classifiedFieldsFor(tenantId, dataset.module, dataset.entity)
  const { rows: safeRows, redacted } = enforceExportClassification(rows, fields, role, matrix)
  return { label: dataset.label, columns: [], rows: safeRows as Record<string, unknown>[], redacted }
}

async function renderExport(
  tenantId: number | null,
  scopeLabel: string,
  datasets: ExportDataset[],
  format: ExportFormat,
  role: TenantRole,
): Promise<{ bytes: Buffer; rowCount: number; redacted: string[]; fileName: string; contentType: string }> {
  const matrix = await getClearanceMatrix()
  const rendered: RenderedDataset[] = []
  for (const dataset of datasets) {
    rendered.push(await collectDataset(tenantId, dataset, role, matrix))
  }

  const rowCount = rendered.reduce((n, d) => n + d.rows.length, 0)
  const redacted = [...new Set(rendered.flatMap((d) => d.redacted))]
  const fileName = exportFileName(scopeLabel, format)
  const contentType = exportContentType(format)
  const bytes = await serializeArtifact(format, scopeLabel, rendered)
  return { bytes, rowCount, redacted, fileName, contentType }
}

async function serializeArtifact(format: ExportFormat, scopeLabel: string, datasets: RenderedDataset[]): Promise<Buffer> {
  switch (format) {
    case "json": {
      const payload = {
        generatedAt: new Date().toISOString(),
        scope: scopeLabel,
        datasets: Object.fromEntries(datasets.map((d) => [d.label, d.rows])),
      }
      return Buffer.from(serializeJson(datasets.length === 1 ? { generatedAt: payload.generatedAt, scope: scopeLabel, rows: datasets[0].rows } : payload), "utf-8")
    }
    case "csv": {
      if (datasets.length === 1) return Buffer.from(serializeCsv(datasets[0].rows), "utf-8")
      const sections = datasets.map((d) => `# ${d.label}\r\n${serializeCsv(d.rows)}`)
      return Buffer.from(sections.join("\r\n\r\n"), "utf-8")
    }
    case "xlsx": {
      const XLSX = await import("xlsx")
      const wb = XLSX.utils.book_new()
      const used = new Set<string>()
      for (const d of datasets) {
        const { aoa } = buildTable(d.rows)
        let name = (d.label || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet"
        let i = 2
        while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i++}`
        used.add(name.toLowerCase())
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [["(no data)"]]), name)
      }
      const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
      return Buffer.isBuffer(out) ? out : Buffer.from(out)
    }
    case "pdf": {
      return renderPdf(scopeLabel, datasets)
    }
    default:
      return Buffer.from(serializeCsv(datasets[0]?.rows ?? []), "utf-8")
  }
}

async function renderPdf(scopeLabel: string, datasets: RenderedDataset[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const margin = 40
  const pageWidth = 595.28
  const pageHeight = 841.89
  const lineHeight = 12
  let page = doc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const draw = (text: string, opts: { font?: typeof font; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 8
    if (y < margin + lineHeight) {
      page = doc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    const clean = text.replace(/[\r\n\t]+/g, " ")
    const maxChars = Math.floor((pageWidth - margin * 2) / (size * 0.5))
    page.drawText(clean.slice(0, maxChars), {
      x: margin,
      y,
      size,
      font: opts.font ?? font,
      color: opts.color ?? rgb(0.1, 0.1, 0.1),
    })
    y -= lineHeight
  }

  draw(scopeLabel, { font: bold, size: 16 })
  draw(`Generated ${new Date().toISOString()}`, { size: 8, color: rgb(0.4, 0.4, 0.4) })
  y -= lineHeight

  for (const d of datasets) {
    draw(`${d.label} — ${d.rows.length} record(s)`, { font: bold, size: 11 })
    if (d.rows.length === 0) {
      draw("(no data)", { size: 8, color: rgb(0.4, 0.4, 0.4) })
    } else {
      const cols = Object.keys(d.rows[0]).slice(0, 8)
      draw(cols.join("  |  "), { font: bold, size: 7, color: rgb(0.3, 0.3, 0.3) })
      const cap = Math.min(d.rows.length, 500)
      for (let i = 0; i < cap; i++) {
        const row = d.rows[i]
        draw(cols.map((c) => `${c}=${row[c] == null ? "" : String(row[c])}`).join("  |  "), { size: 7 })
      }
      if (d.rows.length > cap) draw(`… ${d.rows.length - cap} more row(s) omitted`, { size: 7, color: rgb(0.4, 0.4, 0.4) })
    }
    y -= lineHeight
  }

  const out = await doc.save()
  return Buffer.from(out)
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function listExportSchedules(tenantId: number | null): Promise<ExportSchedule[]> {
  await ensureTables()
  const rows = await query<ScheduleRow[]>(
    `SELECT s.id, s.tenant_id, s.dataset_key, s.scope_label, s.format, s.frequency, s.status,
            s.last_run_at, s.next_run_at, s.created_by, u.name AS created_by_name, s.created_at
       FROM data_export_schedules s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.tenant_id <=> ?
      ORDER BY s.created_at DESC`,
    [tenantId],
  )
  return rows.map(toPublicSchedule)
}

export type CreateScheduleInput = { datasetKey: string; format: unknown; frequency: unknown }

export async function createExportSchedule(
  tenantId: number | null,
  input: CreateScheduleInput,
  actor: Actor,
): Promise<ExportSchedule> {
  await ensureTables()
  const scope = resolveScope(input.datasetKey)
  const format = toExportFormat(input.format)
  const frequency = toExportFrequency(input.frequency)
  const nextRun = computeNextExportRun(frequency, null)

  const res = await query<{ insertId: number }>(
    `INSERT INTO data_export_schedules
       (tenant_id, dataset_key, scope_label, format, frequency, status, next_run_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [tenantId, input.datasetKey, scope.label, format, frequency, nextRun, actor.userId],
  )
  const id = (res as any).insertId as number
  await recordAuditLog({
    action: "data_export.schedule_create",
    entityType: "data_export_schedule",
    entityId: id,
    entityLabel: `${scope.label} (${format.toUpperCase()}, ${frequency})`,
    after: { datasetKey: input.datasetKey, format, frequency, nextRunAt: nextRun.toISOString() },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role,
    },
  })
  const rows = await query<ScheduleRow[]>(
    `SELECT s.id, s.tenant_id, s.dataset_key, s.scope_label, s.format, s.frequency, s.status,
            s.last_run_at, s.next_run_at, s.created_by, u.name AS created_by_name, s.created_at
       FROM data_export_schedules s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`,
    [id],
  )
  return toPublicSchedule(rows[0])
}

export async function deleteExportSchedule(tenantId: number | null, id: number, actor: Actor): Promise<boolean> {
  await ensureTables()
  const rows = await query<ScheduleRow[]>(
    `SELECT * FROM data_export_schedules WHERE id = ? AND tenant_id <=> ? LIMIT 1`,
    [id, tenantId],
  )
  if (rows.length === 0) return false
  await query(`DELETE FROM data_export_schedules WHERE id = ? AND tenant_id <=> ?`, [id, tenantId])
  await recordAuditLog({
    action: "data_export.schedule_delete",
    entityType: "data_export_schedule",
    entityId: id,
    entityLabel: rows[0].scope_label,
    before: { datasetKey: rows[0].dataset_key, format: rows[0].format, frequency: rows[0].frequency },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role,
    },
  })
  return true
}

/**
 * Cron entrypoint: run every due, active schedule across all tenants. Each due
 * schedule produces one export job (scheduler-triggered) and advances its
 * next-run pointer. Failures are isolated per schedule.
 */
export async function runDueExportSchedules(now: Date = new Date()): Promise<{ ran: number; failed: number }> {
  await ensureTables()
  const rows = await query<ScheduleRow[]>(
    `SELECT s.id, s.tenant_id, s.dataset_key, s.scope_label, s.format, s.frequency, s.status,
            s.last_run_at, s.next_run_at, s.created_by, u.name AS created_by_name, s.created_at
       FROM data_export_schedules s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.status = 'active'`,
    [],
  )
  let ran = 0
  let failed = 0
  for (const row of rows) {
    if (!isScheduleDue(row.next_run_at, now)) continue
    const schedule = toPublicSchedule(row)
    const actor: Actor = {
      userId: row.created_by ?? 0,
      name: row.created_by_name,
      email: null,
      role: "tenant_admin",
    }
    try {
      await createAndRunExport(
        row.tenant_id,
        { datasetKey: schedule.datasetKey, format: schedule.format, triggerSource: "scheduler", scheduleId: schedule.id },
        actor,
      )
      ran++
    } catch {
      failed++
    }
    const nextRun = computeNextExportRun(schedule.frequency, now, now)
    await query(`UPDATE data_export_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`, [now, nextRun, row.id])
  }
  return { ran, failed }
}
