import "server-only"
/**
 * SPEC 33 — Queued large exports for the Custom Report Builder (#70, #97).
 * ---------------------------------------------------------------------------
 * The synchronous /api/reports/export path is capped (REPORT_CAPS.maxRows) and
 * returns bytes inline — unusable for million-row extracts. This store adds a
 * durable, tenant-scoped QUEUE:
 *
 *   1. `createLargeExportJob` inserts a `queued` row (idempotent on request_key).
 *   2. A worker (`processLargeExportJob`) streams the report through the SAME
 *      safe compiler + row/field security as the interactive run
 *      (query-builder#runReportForExport), one bounded page at a time, and
 *      writes the assembled artifact to PRIVATE file storage under a
 *      tenant-namespaced key — never a public URL.
 *   3. Completion records a per-artifact HMAC salt so downloads are gated by an
 *      expiring, signed link (never a bare object URL), notifies the requester,
 *      and stamps an expiry.
 *   4. `expireDueLargeExports` deletes artifacts past their policy TTL and
 *      revokes their tokens.
 *
 * Cancellation is cooperative: `cancelLargeExportJob` flips a flag the worker
 * checks between pages, so a runaway export stops promptly without leaving a
 * half-written artifact downloadable.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { runReportForExport } from "@/lib/reports/query-builder"
import { getReport, type Actor } from "@/lib/reports/store"
import { tenantKey } from "@/lib/storage/keys"
import type { StorageProvider } from "@/lib/storage/types"
import { clampExportTtl, isExportExpired } from "@/lib/data-export-model"

export const LARGE_EXPORT_FORMATS = ["csv", "xlsx", "json"] as const
export type LargeExportFormat = (typeof LARGE_EXPORT_FORMATS)[number]

export function toLargeExportFormat(value: unknown): LargeExportFormat {
  return LARGE_EXPORT_FORMATS.includes(value as LargeExportFormat) ? (value as LargeExportFormat) : "csv"
}

export const LARGE_EXPORT_CAPS = {
  /** Absolute ceiling on rows streamed into one artifact. */
  maxRows: 1_000_000,
  /** Rows fetched per page from the database. */
  pageSize: 10_000,
  /** Fail an export rather than buffer an artifact larger than this. */
  maxArtifactBytes: 200 * 1024 * 1024,
} as const

export type LargeExportStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"

const CONTENT_TYPE: Record<LargeExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json; charset=utf-8",
}
const EXTENSION: Record<LargeExportFormat, string> = { csv: "csv", xlsx: "xlsx", json: "json" }

export type LargeExportJob = {
  id: number
  tenantId: number | null
  reportId: number | null
  name: string
  sourceKey: string
  format: LargeExportFormat
  status: LargeExportStatus
  rowCount: number
  byteSize: number
  fileName: string | null
  requestedBy: number | null
  error: string | null
  redactedFields: string[]
  cancelRequested: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null
export function ensureLargeExportSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(
      `CREATE TABLE IF NOT EXISTS report_export_jobs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id INT UNSIGNED NULL,
        report_id INT UNSIGNED NULL,
        report_name VARCHAR(190) NOT NULL,
        source_key VARCHAR(120) NOT NULL,
        definition JSON NOT NULL,
        format VARCHAR(12) NOT NULL DEFAULT 'csv',
        status VARCHAR(16) NOT NULL DEFAULT 'queued',
        row_count INT UNSIGNED NOT NULL DEFAULT 0,
        byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
        file_key VARCHAR(400) NULL,
        file_name VARCHAR(190) NULL,
        content_type VARCHAR(120) NULL,
        storage_provider VARCHAR(40) NULL,
        token_salt VARCHAR(64) NULL,
        requested_by INT UNSIGNED NULL,
        request_key VARCHAR(120) NULL,
        error TEXT NULL,
        redacted_fields TEXT NULL,
        cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP NULL DEFAULT NULL,
        finished_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_export_request (tenant_id, request_key),
        KEY idx_export_tenant (tenant_id, created_at),
        KEY idx_export_status (status),
        KEY idx_export_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ).then(() => undefined)
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Signed-download token (HMAC over id + tenant + expiry + per-artifact salt)
// ---------------------------------------------------------------------------
function tokenSecret(): string {
  return process.env.EXPORT_TOKEN_SECRET || process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET || "muenot-report-export"
}

function signToken(id: number, tenantId: number | null, exp: number, salt: string): string {
  return createHmac("sha256", tokenSecret()).update(`${id}.${tenantId ?? 0}.${exp}.${salt}`).digest("hex")
}

/** Build the relative, signed, expiring download path for a completed artifact. */
export function buildLargeExportDownloadPath(job: { id: number; tenantId: number | null }, salt: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + clampExportTtl(ttlSeconds)
  const sig = signToken(job.id, job.tenantId, exp, salt)
  return `/api/reports/exports/${job.id}/download?exp=${exp}&sig=${sig}`
}

function verifyToken(job: { id: number; tenantId: number | null; token_salt: string | null }, exp: number, sig: string): boolean {
  if (!job.token_salt) return false
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false
  const expected = signToken(job.id, job.tenantId, exp, job.token_salt)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------
type Row = {
  id: number
  tenant_id: number | null
  report_id: number | null
  report_name: string
  source_key: string
  format: string
  status: string
  row_count: number
  byte_size: number | string
  file_key: string | null
  file_name: string | null
  content_type: string | null
  storage_provider: string | null
  token_salt: string | null
  requested_by: number | null
  error: string | null
  redacted_fields: string | null
  cancel_requested: number
  expires_at: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

function toJob(r: Row): LargeExportJob {
  return {
    id: Number(r.id),
    tenantId: r.tenant_id == null ? null : Number(r.tenant_id),
    reportId: r.report_id == null ? null : Number(r.report_id),
    name: r.report_name,
    sourceKey: r.source_key,
    format: toLargeExportFormat(r.format),
    status: (r.status as LargeExportStatus) ?? "queued",
    rowCount: Number(r.row_count),
    byteSize: Number(r.byte_size),
    fileName: r.file_name,
    requestedBy: r.requested_by == null ? null : Number(r.requested_by),
    error: r.error,
    redactedFields: r.redacted_fields ? String(r.redacted_fields).split(",").filter(Boolean) : [],
    cancelRequested: Number(r.cancel_requested) === 1,
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : null,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
  }
}

const PUBLIC_COLS =
  "id, tenant_id, report_id, report_name, source_key, format, status, row_count, byte_size, file_key, file_name, content_type, storage_provider, token_salt, requested_by, error, redacted_fields, cancel_requested, expires_at, created_at, started_at, finished_at"

// ---------------------------------------------------------------------------
// Create / list / get
// ---------------------------------------------------------------------------
export type CreateLargeExportInput = {
  /** Provide either a saved reportId OR an ad-hoc definition. */
  reportId?: number | null
  definition?: unknown
  name?: string | null
  format?: unknown
  /** Optional client idempotency key; a retry returns the SAME job. */
  requestKey?: string | null
}

export async function createLargeExportJob(
  tenantId: number | null,
  input: CreateLargeExportInput,
  actor: Actor,
): Promise<LargeExportJob> {
  await ensureLargeExportSchema()
  if (tenantId == null || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Large exports require a tenant context.")
  }

  let definition: any = input.definition ?? null
  let reportId: number | null = null
  let name = (input.name ?? "").trim()

  if (input.reportId != null) {
    const saved = await getReport(tenantId, Number(input.reportId))
    if (!saved) throw new Error("Saved report not found.")
    definition = saved.definition
    reportId = saved.id
    if (!name) name = saved.name
  }

  if (!definition || typeof definition !== "object") throw new Error("A report definition is required.")
  const sourceKey = String(definition.sourceKey ?? "")
  if (!sourceKey) throw new Error("The report definition is missing a data source.")
  if (!name) name = "report"
  const format = toLargeExportFormat(input.format)
  const requestKey = input.requestKey ? String(input.requestKey).slice(0, 120) : null

  // Idempotency: a repeated requestKey returns the existing job untouched.
  if (requestKey) {
    const existing = await query<Row[]>(
      `SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE tenant_id = ? AND request_key = ? LIMIT 1`,
      [tenantId, requestKey],
    )
    if (existing[0]) return toJob(existing[0])
  }

  try {
    const res = await query<{ insertId: number }>(
      `INSERT INTO report_export_jobs
        (tenant_id, report_id, report_name, source_key, definition, format, status, requested_by, request_key)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, 'queued', ?, ?)`,
      [tenantId, reportId, name.slice(0, 190), sourceKey.slice(0, 120), JSON.stringify(definition), format, actor.userId, requestKey],
    )
    const id = Number((res as any).insertId)
    await recordAuditLog(
      {
        action: "report.export.queued",
        entityType: "report_export",
        entityId: id,
        entityLabel: name,
        after: { sourceKey, format, reportId },
      },
      auditContext(tenantId, actor),
    ).catch(() => {})
    const rows = await query<Row[]>(`SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE id = ? AND tenant_id = ?`, [id, tenantId])
    return toJob(rows[0]!)
  } catch (err: any) {
    // Lost the idempotency race: another request inserted the same key first.
    if (requestKey && err?.code === "ER_DUP_ENTRY") {
      const existing = await query<Row[]>(
        `SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE tenant_id = ? AND request_key = ? LIMIT 1`,
        [tenantId, requestKey],
      )
      if (existing[0]) return toJob(existing[0])
    }
    throw err
  }
}

export async function listLargeExportJobs(tenantId: number | null, provider?: StorageProvider): Promise<LargeExportJob[]> {
  await ensureLargeExportSchema()
  // Enforce retention on read so expired artifacts never linger even without a
  // cron. Deletion needs a provider; when absent we still revoke the token.
  await expireDueLargeExports(tenantId, provider).catch(() => {})
  const rows = await query<Row[]>(
    `SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE tenant_id <=> ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    [tenantId],
  )
  return rows.map(toJob)
}

export async function getLargeExportJob(tenantId: number | null, id: number): Promise<LargeExportJob | null> {
  await ensureLargeExportSchema()
  const rows = await query<Row[]>(`SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE id = ? AND tenant_id <=> ?`, [id, tenantId])
  return rows[0] ? toJob(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
export async function cancelLargeExportJob(tenantId: number | null, id: number, actor: Actor): Promise<LargeExportJob | null> {
  await ensureLargeExportSchema()
  // Terminal queued jobs cancel immediately; a running job is flagged and the
  // worker stops between pages. Completed/failed/expired jobs are unaffected.
  await query(
    `UPDATE report_export_jobs
       SET cancel_requested = 1,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN UTC_TIMESTAMP() ELSE finished_at END
     WHERE id = ? AND tenant_id <=> ? AND status IN ('queued','running')`,
    [id, tenantId],
  )
  await recordAuditLog(
    { action: "report.export.cancel_requested", entityType: "report_export", entityId: id },
    auditContext(tenantId, actor),
  ).catch(() => {})
  return getLargeExportJob(tenantId, id)
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = v instanceof Date ? v.toISOString() : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/**
 * Execute one queued job to completion. Idempotent on status: it only claims a
 * job that is still `queued`, so a duplicate trigger is a no-op. Runs OUTSIDE a
 * request (via `after()` or a test), taking the storage `provider` and identity
 * explicitly rather than from async-local context.
 */
export async function processLargeExportJob(
  jobId: number,
  ctx: { provider: StorageProvider; tenantId: number | null; actor: Actor; ttlSeconds?: number },
): Promise<LargeExportJob | null> {
  await ensureLargeExportSchema()
  const { provider, tenantId, actor } = ctx

  // Claim the job — only one worker can transition queued -> running.
  const claim = await query<{ affectedRows: number }>(
    `UPDATE report_export_jobs SET status = 'running', started_at = UTC_TIMESTAMP()
     WHERE id = ? AND tenant_id <=> ? AND status = 'queued'`,
    [jobId, tenantId],
  )
  if (Number((claim as any).affectedRows) !== 1) return getLargeExportJob(tenantId, jobId)

  const job = await getLargeExportJob(tenantId, jobId)
  if (!job) return null

  const defRows = await query<{ definition: any }[]>(`SELECT definition FROM report_export_jobs WHERE id = ?`, [jobId])
  const definition = normalizeDefinition(defRows[0]?.definition)
  const format = job.format
  const ttlSeconds = clampExportTtl(ctx.ttlSeconds)

  try {
    const parts: Buffer[] = []
    let bytes = 0
    const jsonRows: Record<string, unknown>[] = []
    let headerWritten = false

    const pushBytes = (buf: Buffer) => {
      parts.push(buf)
      bytes += buf.length
      if (bytes > LARGE_EXPORT_CAPS.maxArtifactBytes) {
        throw new Error("Export exceeds the maximum artifact size. Add filters or split the report.")
      }
    }

    const result = await runReportForExport(
      definition,
      {
        tenantId,
        role: actor.role,
        userId: actor.userId,
        pageSize: LARGE_EXPORT_CAPS.pageSize,
        maxRows: LARGE_EXPORT_CAPS.maxRows,
        // Cooperative cancellation: re-read the flag before each page.
        shouldContinue: async () => {
          const r = await query<{ cancel_requested: number }[]>(
            `SELECT cancel_requested FROM report_export_jobs WHERE id = ?`,
            [jobId],
          )
          return !(r[0] && Number(r[0].cancel_requested) === 1)
        },
      },
      async (page) => {
        if (format === "csv") {
          if (!headerWritten) {
            pushBytes(Buffer.from(page.columns.map((c) => csvEscape(c.label)).join(",") + "\r\n", "utf-8"))
            headerWritten = true
          }
          if (page.rows.length) {
            const chunk =
              page.rows.map((row) => page.columns.map((c) => csvEscape(row[c.key])).join(",")).join("\r\n") + "\r\n"
            pushBytes(Buffer.from(chunk, "utf-8"))
          }
        } else {
          for (const row of page.rows) {
            const labeled: Record<string, unknown> = {}
            for (const c of page.columns) labeled[c.label] = row[c.key] ?? null
            jsonRows.push(labeled)
          }
          if (jsonRows.length > LARGE_EXPORT_CAPS.maxRows) {
            throw new Error("Export exceeds the maximum row count. Add filters or split the report.")
          }
        }
      },
    )

    if (result.cancelled) {
      await query(
        `UPDATE report_export_jobs SET status = 'cancelled', finished_at = UTC_TIMESTAMP() WHERE id = ?`,
        [jobId],
      )
      await recordAuditLog(
        { action: "report.export.cancelled", entityType: "report_export", entityId: jobId },
        auditContext(tenantId, actor),
      ).catch(() => {})
      return getLargeExportJob(tenantId, jobId)
    }

    // Assemble the artifact bytes for buffered formats.
    let artifact: Buffer
    if (format === "csv") {
      artifact = Buffer.concat(parts)
    } else if (format === "json") {
      artifact = Buffer.from(
        JSON.stringify({ report: job.name, generatedAt: new Date().toISOString(), rowCount: result.totalRows, rows: jsonRows }),
        "utf-8",
      )
    } else {
      const XLSX = await import("xlsx")
      const ws = XLSX.utils.json_to_sheet(jsonRows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, "Report")
      artifact = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
    }
    if (artifact.length > LARGE_EXPORT_CAPS.maxArtifactBytes) {
      throw new Error("Export exceeds the maximum artifact size. Add filters or split the report.")
    }

    // Write to PRIVATE storage under a tenant-namespaced key + per-artifact salt.
    const ext = EXTENSION[format]
    const key = tenantKey(tenantId!, `report-exports/${jobId}-${randomBytes(8).toString("hex")}.${ext}`)
    const contentType = CONTENT_TYPE[format]
    const uploaded = await provider.upload(key, artifact, contentType, { public: false })
    const salt = randomBytes(16).toString("hex")
    const fileName = `${slug(job.name)}-${new Date().toISOString().slice(0, 10)}.${ext}`

    await query(
      `UPDATE report_export_jobs
         SET status = 'completed', row_count = ?, byte_size = ?, file_key = ?, file_name = ?,
             content_type = ?, storage_provider = ?, token_salt = ?, redacted_fields = ?,
             expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), finished_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [
        result.totalRows,
        uploaded.size || artifact.length,
        key,
        fileName,
        contentType,
        provider.id,
        salt,
        result.redactedFields.join(","),
        ttlSeconds,
        jobId,
      ],
    )

    await recordAuditLog(
      {
        action: "report.export.completed",
        entityType: "report_export",
        entityId: jobId,
        entityLabel: job.name,
        after: { rows: result.totalRows, bytes: artifact.length, format, truncated: result.truncated },
      },
      auditContext(tenantId, actor),
    ).catch(() => {})

    if (job.requestedBy) {
      const link = buildLargeExportDownloadPath({ id: jobId, tenantId }, salt, ttlSeconds)
      await notifyRequester(tenantId!, job.requestedBy, jobId, {
        title: "Report export ready",
        body: `"${job.name}" (${result.totalRows.toLocaleString()} rows) is ready to download.`,
        link,
      }).catch(() => {})
    }

    return getLargeExportJob(tenantId, jobId)
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message.slice(0, 500) : "Export failed."
    await query(
      `UPDATE report_export_jobs SET status = 'failed', error = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?`,
      [message, jobId],
    ).catch(() => {})
    await recordAuditLog(
      { action: "report.export.failed", result: "failure", entityType: "report_export", entityId: jobId, metadata: { error: message } },
      auditContext(tenantId, actor),
    ).catch(() => {})
    console.error("[v0] report export job failed:", err)
    return getLargeExportJob(tenantId, jobId)
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
export type ResolvedDownload =
  | { ok: true; body: ReadableStream<Uint8Array> | Buffer; contentType: string; fileName: string; size: number | null }
  | { ok: false; status: 403 | 404 | 410; reason: string }

export async function resolveLargeExportDownload(
  tenantId: number | null,
  id: number,
  exp: number,
  sig: string,
  provider: StorageProvider,
): Promise<ResolvedDownload> {
  await ensureLargeExportSchema()
  const rows = await query<Row[]>(
    `SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE id = ? AND tenant_id <=> ?`,
    [id, tenantId],
  )
  const row = rows[0]
  if (!row) return { ok: false, status: 404, reason: "Export not found." }
  if (!verifyToken({ id: Number(row.id), tenantId: row.tenant_id == null ? null : Number(row.tenant_id), token_salt: row.token_salt }, exp, sig)) {
    return { ok: false, status: 403, reason: "Invalid or expired download link." }
  }
  if (row.status !== "completed" || !row.file_key) return { ok: false, status: 410, reason: "Export is no longer available." }
  if (isExportExpired(row.expires_at)) return { ok: false, status: 410, reason: "Export has expired." }

  const download = await provider.download(row.file_key)
  return {
    ok: true,
    body: download.body,
    contentType: row.content_type || download.contentType || "application/octet-stream",
    fileName: row.file_name || `report-${id}.${EXTENSION[toLargeExportFormat(row.format)]}`,
    size: download.size ?? null,
  }
}

/**
 * Mint a fresh signed, short-lived download link for a COMPLETED, unexpired
 * artifact. Returns null when the job cannot (or should not) be downloaded, so
 * the API only ever advertises a working link.
 */
export async function getLargeExportDownloadLink(
  tenantId: number | null,
  id: number,
  linkTtlSeconds = 3600,
): Promise<string | null> {
  await ensureLargeExportSchema()
  const rows = await query<Row[]>(`SELECT ${PUBLIC_COLS} FROM report_export_jobs WHERE id = ? AND tenant_id <=> ?`, [id, tenantId])
  const row = rows[0]
  if (!row || row.status !== "completed" || !row.token_salt || !row.file_key) return null
  if (isExportExpired(row.expires_at)) return null
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, linkTtlSeconds)
  const sig = signToken(id, tenantId, exp, row.token_salt)
  return `/api/reports/exports/${id}/download?exp=${exp}&sig=${sig}`
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------
export async function expireDueLargeExports(tenantId: number | null, provider?: StorageProvider): Promise<number> {
  await ensureLargeExportSchema()
  const due = await query<{ id: number; file_key: string | null }[]>(
    `SELECT id, file_key FROM report_export_jobs
     WHERE tenant_id <=> ? AND status = 'completed' AND expires_at IS NOT NULL AND expires_at < UTC_TIMESTAMP()`,
    [tenantId],
  )
  let expired = 0
  for (const r of due) {
    if (provider && r.file_key) {
      try {
        await provider.delete(r.file_key)
      } catch (err) {
        console.error("[v0] failed deleting expired export artifact:", err)
      }
    }
    await query(
      `UPDATE report_export_jobs SET status = 'expired', file_key = NULL, token_salt = NULL WHERE id = ?`,
      [Number(r.id)],
    )
    expired++
  }
  return expired
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function auditContext(tenantId: number | null, actor: Actor) {
  return {
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role,
    },
  }
}

function slug(name: string): string {
  return (name || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report"
}

function normalizeDefinition(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

async function notifyRequester(
  tenantId: number,
  userId: number,
  jobId: number,
  notice: { title: string; body: string; link: string },
): Promise<void> {
  const { ensureNotificationEngineSchema } = await import("@/lib/notification-engine/schema")
  const { enqueueNotification } = await import("@/lib/notification-engine/service")
  await ensureNotificationEngineSchema()
  await withTransaction(async (c) => {
    await enqueueNotification(c, {
      tenantId,
      userId,
      channel: "in_app",
      key: `report-export:${jobId}`,
      title: notice.title,
      body: notice.body,
      link: notice.link,
      context: { kind: "report_export", jobId },
    })
  })
}
