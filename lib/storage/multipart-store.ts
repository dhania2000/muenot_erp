import "server-only"
import { query } from "@/lib/db"
import { currentTenantId, scopedWhere, tenantInsert, tenantUpdate, tenantDelete } from "@/lib/tenant-scope"
import type { MultipartPart } from "./types"

/**
 * Resumable multipart upload session store.
 * ---------------------------------------------------------------------------
 * A "session" is one large file being uploaded in chunks. The heavy bytes live
 * in the tenant's storage backend (S3 / Vercel Blob); this store only tracks
 * the coordination state so an upload can be:
 *
 *   - resumed        — the client asks which part numbers already landed and
 *                      only re-sends the missing ones after a refresh/crash.
 *   - retried        — a single failed chunk is re-PUT without restarting.
 *   - cancelled      — the provider multipart upload is aborted and the session
 *                      is marked so its key can never be completed.
 *   - progress-shown — total_parts + received parts drive an accurate bar.
 *
 * Both tables are tenant-owned (lib/tenant-tables.ts), so every access here is
 * scoped through the tenant-scope helpers and one tenant can never see, resume,
 * or abort another tenant's upload.
 */

const SESSIONS = "storage_upload_sessions"
const PARTS = "storage_upload_parts"

export type UploadCategory =
  | "video"
  | "image"
  | "document"
  | "zip"
  | "training"
  | "employee"
  | "other"

export type UploadSessionRow = {
  id: number
  tenant_id: number
  upload_id: string
  storage_key: string
  provider: string
  filename: string
  content_type: string | null
  total_size: number
  part_size: number
  total_parts: number
  status: "active" | "completed" | "aborted"
  category: string
  /** Logical ERP module the finished object belongs to (drives metadata row). */
  module: string | null
  /** Client-declared SHA-256 of the whole file, recorded for integrity. */
  checksum: string | null
  created_by: number | null
  created_at: string | null
  updated_at: string | null
}

/** Client-safe view of a session, including which parts already arrived. */
export type UploadSessionStatus = {
  id: number
  storageKey: string
  filename: string
  contentType: string | null
  totalSize: number
  partSize: number
  totalParts: number
  status: "active" | "completed" | "aborted"
  category: string
  module: string | null
  checksum: string | null
  uploadedParts: number[]
  uploadedBytes: number
  createdAt: string | null
}

let ensured = false

export async function ensureUploadSchema(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS ${SESSIONS} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      upload_id VARCHAR(1024) NOT NULL,
      storage_key VARCHAR(1024) NOT NULL,
      provider VARCHAR(40) NOT NULL,
      filename VARCHAR(500) NOT NULL,
      content_type VARCHAR(255) DEFAULT NULL,
      total_size BIGINT NOT NULL DEFAULT 0,
      part_size BIGINT NOT NULL DEFAULT 0,
      total_parts INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      category VARCHAR(40) NOT NULL DEFAULT 'other',
      module VARCHAR(64) DEFAULT NULL,
      checksum CHAR(64) DEFAULT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_sus_tenant (tenant_id),
      KEY idx_sus_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // Older deployments predate the module/checksum columns; add them idempotently
  // (MySQL has no portable "ADD COLUMN IF NOT EXISTS", so tolerate the dup error).
  await query(`ALTER TABLE ${SESSIONS} ADD COLUMN module VARCHAR(64) DEFAULT NULL`).catch(() => {})
  await query(`ALTER TABLE ${SESSIONS} ADD COLUMN checksum CHAR(64) DEFAULT NULL`).catch(() => {})
  await query(`
    CREATE TABLE IF NOT EXISTS ${PARTS} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      session_id BIGINT NOT NULL,
      part_number INT NOT NULL,
      etag VARCHAR(512) NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sup_session_part (session_id, part_number),
      KEY idx_sup_tenant (tenant_id),
      KEY idx_sup_session (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  ensured = true
}

export async function createSession(input: {
  uploadId: string
  storageKey: string
  provider: string
  filename: string
  contentType: string | null
  totalSize: number
  partSize: number
  totalParts: number
  category: UploadCategory
  /** Logical ERP module the finished object belongs to (drives the metadata row). */
  module?: string | null
  /** Client-declared SHA-256 (lowercase hex) of the whole file, for integrity. */
  checksum?: string | null
  userId?: number | null
}): Promise<number> {
  await ensureUploadSchema()
  const { insertId } = await tenantInsert(SESSIONS, {
    upload_id: input.uploadId,
    storage_key: input.storageKey,
    provider: input.provider,
    filename: input.filename.slice(0, 500),
    content_type: input.contentType,
    total_size: input.totalSize,
    part_size: input.partSize,
    total_parts: input.totalParts,
    status: "active",
    category: input.category,
    module: input.module ?? null,
    checksum: normalizeChecksum(input.checksum),
    created_by: input.userId ?? null,
  })
  return insertId
}

/** Accept only a well-formed lowercase 64-hex SHA-256; anything else is dropped. */
export function normalizeChecksum(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(v) ? v : null
}

export async function getSession(id: number): Promise<UploadSessionRow | null> {
  await ensureUploadSchema()
  const { where, params } = scopedWhere(SESSIONS, "id = ?", [id])
  const rows = await query<any[]>(`SELECT * FROM ${SESSIONS} ${where} LIMIT 1`, params)
  return (rows[0] as UploadSessionRow) ?? null
}

/**
 * Record (or overwrite) one uploaded part. Idempotent by (session, part) so a
 * retried chunk simply replaces the previous ETag instead of duplicating.
 */
export async function recordPart(
  sessionId: number,
  part: MultipartPart & { size: number },
): Promise<void> {
  await ensureUploadSchema()
  const tenantId = currentTenantId()
  await query(
    `INSERT INTO ${PARTS} (tenant_id, session_id, part_number, etag, size)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE etag = VALUES(etag), size = VALUES(size)`,
    [tenantId, sessionId, part.partNumber, part.etag, part.size],
  )
  // Touch the session so updated_at reflects progress.
  await tenantUpdate(SESSIONS, { status: "active" }, "id = ? AND status = 'active'", [sessionId])
}

export async function getParts(sessionId: number): Promise<(MultipartPart & { size: number })[]> {
  await ensureUploadSchema()
  const { where, params } = scopedWhere(PARTS, "session_id = ?", [sessionId])
  const rows = await query<any[]>(
    `SELECT part_number, etag, size FROM ${PARTS} ${where} ORDER BY part_number ASC`,
    params,
  )
  return rows.map((r) => ({ partNumber: Number(r.part_number), etag: String(r.etag), size: Number(r.size) }))
}

export async function markCompleted(sessionId: number): Promise<void> {
  await ensureUploadSchema()
  await tenantUpdate(SESSIONS, { status: "completed" }, "id = ?", [sessionId])
}

export async function markAborted(sessionId: number): Promise<void> {
  await ensureUploadSchema()
  await tenantUpdate(SESSIONS, { status: "aborted" }, "id = ?", [sessionId])
}

export async function deleteSessionParts(sessionId: number): Promise<void> {
  await ensureUploadSchema()
  await tenantDelete(PARTS, "session_id = ?", [sessionId])
}

/** Active sessions for the current tenant — used to offer resume on return. */
export async function listActiveSessions(limit = 50): Promise<UploadSessionStatus[]> {
  await ensureUploadSchema()
  const { where, params } = scopedWhere(SESSIONS, "status = 'active'")
  const rows = await query<any[]>(
    `SELECT * FROM ${SESSIONS} ${where} ORDER BY id DESC LIMIT ?`,
    [...params, limit],
  )
  const out: UploadSessionStatus[] = []
  for (const r of rows) out.push(await toStatus(r as UploadSessionRow))
  return out
}

export async function getSessionStatus(id: number): Promise<UploadSessionStatus | null> {
  const row = await getSession(id)
  if (!row) return null
  return toStatus(row)
}

async function toStatus(row: UploadSessionRow): Promise<UploadSessionStatus> {
  const parts = await getParts(row.id)
  const uploadedBytes = parts.reduce((sum, p) => sum + (p.size || 0), 0)
  return {
    id: row.id,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: row.content_type,
    totalSize: Number(row.total_size),
    partSize: Number(row.part_size),
    totalParts: Number(row.total_parts),
    status: row.status,
    category: row.category,
    module: row.module ?? null,
    checksum: row.checksum ?? null,
    uploadedParts: parts.map((p) => p.partNumber),
    uploadedBytes,
    createdAt: row.created_at,
  }
}
