import "server-only"
import { createHash } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { ensureEventSchema } from "@/lib/events/schema"
import { publishEvent } from "@/lib/events/bus"
import {
  currentTenantId,
  scopedWhere,
  tenantUpdate,
  CrossTenantAccessError,
} from "@/lib/tenant-scope"
import { keyBelongsToTenant, tenantIdFromKey } from "./keys"
import {
  normalizeClassification,
  normalizeRetentionPolicy,
  computeRetentionExpiry,
  type FileClassification,
  type RetentionPolicyId,
} from "./file-metadata-policy"
import type { StorageProviderId } from "./providers"

/**
 * SPEC 32 — Centralized file metadata.
 * ---------------------------------------------------------------------------
 * A single normalized model (`file_objects`) that records the metadata for
 * EVERY file the ERP stores, regardless of which module owns it. Before this
 * spec each module kept its own ad-hoc columns (product_documents.url,
 * expenses.storage_url, hr_employee_documents, …) with no consistent notion of
 * provider, hash, upload status, version, retention or classification — so
 * there was no way to audit, verify integrity, apply a retention policy, or
 * reason about a tenant's total storage footprint across modules.
 *
 * This module is the one place that:
 *   - stores the canonical metadata row (tenant, owner, module, entity, object
 *     key, provider, MIME, size, hash, status, version, retention, classification),
 *   - versions successive uploads of the same logical file (is_current chain),
 *   - runs the lifecycle transitions (pending → completed / failed → deleted),
 *   - powers integrity checks (recompute the hash and compare) and retention
 *     sweeps (find/expire objects past their retention date).
 *
 * It builds on the existing storage stack: keys are tenant-namespaced
 * (lib/storage/keys.ts), and all access goes through the tenant-scope helpers
 * so one tenant can never see or mutate another's file rows.
 */

const TABLE = "file_objects"

// Metadata persistence and upload-completion publication share one transaction.
// Columns come only from this module's reviewed maps, never request SQL.
async function writeFileRecord(values:Record<string,unknown>,id?:number):Promise<{insertId:number;affectedRows:number}> {
  await ensureEventSchema()
  const tenantId=currentTenantId()
  return withTransaction(async c=>{
    const columns=Object.keys(values)
    const data=Object.values(values)
    let result:any
    if(id!==undefined) {
      const [owned]=await c.query<any[]>("SELECT id FROM file_objects WHERE tenant_id=? AND id=? FOR UPDATE",[tenantId,id])
      if(!owned.length) return {insertId:0,affectedRows:0}
      ;[result]=await c.query("UPDATE file_objects SET "+columns.map(k=>"`"+k+"`=?").join(",")+" WHERE tenant_id=? AND id=?",[...data,tenantId,id])
    } else {
      ;[result]=await c.query("INSERT INTO file_objects ("+columns.map(k=>"`"+k+"`").join(",")+",tenant_id) VALUES ("+columns.map(()=>"?").join(",")+",?)",[...data,tenantId])
    }
    const fileId=id ?? Number(result.insertId)
    if(values.upload_status==="completed") await publishEvent(c,{tenantId,type:"file.uploaded",entityId:fileId,key:`file:${fileId}:uploaded`,actorId:Number(values.owner_id)||null})
    return {insertId:fileId,affectedRows:Number(result.affectedRows)}
  })
}

export type FileUploadStatus = "pending" | "uploading" | "completed" | "failed" | "deleted"

const UPLOAD_STATUSES: readonly FileUploadStatus[] = [
  "pending",
  "uploading",
  "completed",
  "failed",
  "deleted",
]

export function normalizeUploadStatus(value: string | null | undefined): FileUploadStatus {
  return UPLOAD_STATUSES.includes(value as FileUploadStatus) ? (value as FileUploadStatus) : "pending"
}

export type FileObjectRow = {
  id: number
  tenant_id: number
  file_ref: string
  owner_id: number | null
  module: string
  entity_type: string | null
  entity_id: string | null
  object_key: string
  provider: string
  filename: string | null
  mime_type: string | null
  size_bytes: number
  checksum_sha256: string | null
  upload_status: FileUploadStatus
  version: number
  is_current: 0 | 1
  supersedes_id: number | null
  classification: FileClassification
  retention_policy: string
  retention_expires_at: string | null
  legal_hold: 0 | 1
  created_by: number | null
  created_at: string | null
  updated_at: string | null
  deleted_at: string | null
  deleted_by: number | null
}

/** Client-safe projection (never leaks internal-only columns beyond what UIs need). */
export type FileObject = {
  id: number
  fileRef: string
  module: string
  entityType: string | null
  entityId: string | null
  objectKey: string
  provider: string
  filename: string | null
  mimeType: string | null
  size: number
  checksum: string | null
  uploadStatus: FileUploadStatus
  version: number
  isCurrent: boolean
  classification: FileClassification
  retentionPolicy: string
  retentionExpiresAt: string | null
  legalHold: boolean
  ownerId: number | null
  createdAt: string | null
  updatedAt: string | null
}

export function toFileObject(row: FileObjectRow): FileObject {
  return {
    id: Number(row.id),
    fileRef: row.file_ref,
    module: row.module,
    entityType: row.entity_type,
    entityId: row.entity_id,
    objectKey: row.object_key,
    provider: row.provider,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    checksum: row.checksum_sha256,
    uploadStatus: normalizeUploadStatus(row.upload_status),
    version: Number(row.version),
    isCurrent: Number(row.is_current) === 1,
    classification: normalizeClassification(row.classification),
    retentionPolicy: row.retention_policy,
    retentionExpiresAt: row.retention_expires_at,
    legalHold: Number(row.legal_hold) === 1,
    ownerId: row.owner_id == null ? null : Number(row.owner_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

/** Idempotently create the `file_objects` table + indexes. Safe to call often. */
export function ensureFileMetadataSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      file_ref VARCHAR(40) NOT NULL,
      owner_id INT DEFAULT NULL,
      module VARCHAR(60) NOT NULL,
      entity_type VARCHAR(80) DEFAULT NULL,
      entity_id VARCHAR(120) DEFAULT NULL,
      object_key VARCHAR(1024) NOT NULL,
      provider VARCHAR(40) NOT NULL,
      filename VARCHAR(500) DEFAULT NULL,
      mime_type VARCHAR(255) DEFAULT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      checksum_sha256 CHAR(64) DEFAULT NULL,
      upload_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      version INT UNSIGNED NOT NULL DEFAULT 1,
      is_current TINYINT(1) NOT NULL DEFAULT 1,
      supersedes_id BIGINT DEFAULT NULL,
      classification VARCHAR(20) NOT NULL DEFAULT 'internal',
      retention_policy VARCHAR(30) NOT NULL DEFAULT 'default',
      retention_expires_at DATETIME DEFAULT NULL,
      legal_hold TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      deleted_by INT DEFAULT NULL,
      UNIQUE KEY uq_fo_tenant_key (tenant_id, object_key),
      UNIQUE KEY uq_fo_tenant_ref (tenant_id, file_ref),
      KEY idx_fo_tenant (tenant_id),
      KEY idx_fo_entity (tenant_id, module, entity_type, entity_id),
      KEY idx_fo_status (tenant_id, upload_status),
      KEY idx_fo_checksum (tenant_id, checksum_sha256),
      KEY idx_fo_retention (retention_expires_at),
      KEY idx_fo_current (tenant_id, is_current)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

// ---------------------------------------------------------------------------
// Hashing / integrity
// ---------------------------------------------------------------------------

/** Compute the canonical SHA-256 (lowercase hex) of a buffer. */
export function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Constant-shape integrity comparison. */
export function checksumMatches(expected: string | null | undefined, actual: string | null | undefined): boolean {
  if (!expected || !actual) return false
  return expected.toLowerCase() === actual.toLowerCase()
}

// ---------------------------------------------------------------------------
// File-ref generation
// ---------------------------------------------------------------------------

/** Build the stable, human-readable file reference (FILE-000042). */
export function formatFileRef(id: number): string {
  return `FILE-${String(id).padStart(6, "0")}`
}

// ---------------------------------------------------------------------------
// Recording (create / version)
// ---------------------------------------------------------------------------

export type RecordFileInput = {
  /** Canonical, tenant-namespaced storage key (already produced by the facade). */
  objectKey: string
  provider: StorageProviderId | string
  module: string
  entityType?: string | null
  entityId?: string | number | null
  filename?: string | null
  mimeType?: string | null
  size: number
  checksum?: string | null
  ownerId?: number | null
  classification?: string | null
  retentionPolicy?: string | null
  /** Anchor date for retention (defaults to now). */
  retentionFrom?: Date | null
  uploadStatus?: FileUploadStatus
}

/**
 * Record (or version) a file's metadata. When a file already exists for the
 * same logical target — same (module, entity, filename) — the previous current
 * row is retired (is_current = 0) and this becomes version N+1 pointing back at
 * it via supersedes_id. Object keys are unique per tenant, so re-recording the
 * exact same key updates that row in place instead of creating a duplicate.
 */
export async function recordFileMetadata(input: RecordFileInput): Promise<FileObject> {
  await ensureFileMetadataSchema()
  const tenantId = currentTenantId()

  // The object key already encodes the tenant; reject anything that doesn't.
  if (!keyBelongsToTenant(input.objectKey, tenantId)) {
    throw new CrossTenantAccessError("File key does not belong to the current tenant")
  }

  const classification = normalizeClassification(input.classification)
  const retentionPolicy = normalizeRetentionPolicy(input.retentionPolicy)
  const retentionExpiresAt = computeRetentionExpiry(retentionPolicy, input.retentionFrom ?? new Date())
  const status = input.uploadStatus ?? "completed"
  const module = input.module.trim().slice(0, 60) || "misc"
  const entityType = input.entityType ? String(input.entityType).slice(0, 80) : null
  const entityId = input.entityId == null ? null : String(input.entityId).slice(0, 120)
  const filename = input.filename ? String(input.filename).slice(0, 500) : null
  const mimeType = input.mimeType ? String(input.mimeType).slice(0, 255) : null

  // Same object key → update the existing row in place (idempotent re-record,
  // e.g. a multipart completion following a pending create).
  const existingByKey = await getByObjectKey(input.objectKey)
  if (existingByKey) {
    await writeFileRecord(
      {
        provider: String(input.provider),
        module,
        entity_type: entityType,
        entity_id: entityId,
        filename,
        mime_type: mimeType,
        size_bytes: Math.max(0, Math.floor(input.size)),
        checksum_sha256: input.checksum ?? existingByKey.checksum,
        upload_status: status,
        classification,
        retention_policy: retentionPolicy,
        retention_expires_at: retentionExpiresAt,
        owner_id: input.ownerId ?? existingByKey.ownerId,
      },
      existingByKey.id,
    )
    const refreshed = await getFileById(existingByKey.id)
    return refreshed!
  }

  // Version chain: find the current row for the same logical target.
  let version = 1
  let supersedesId: number | null = null
  if (entityType && filename) {
    const { where, params } = scopedWhere(
      TABLE,
      "module = ? AND entity_type = ? AND (entity_id <=> ?) AND filename = ? AND is_current = 1 AND upload_status <> 'deleted'",
      [module, entityType, entityId, filename],
    )
    const prevRows = await query<FileObjectRow[]>(
      `SELECT * FROM ${TABLE} ${where} ORDER BY version DESC LIMIT 1`,
      params,
    )
    const prev = prevRows[0]
    if (prev) {
      version = Number(prev.version) + 1
      supersedesId = Number(prev.id)
    }
  }

  const { insertId } = await writeFileRecord({
    file_ref: "PENDING",
    owner_id: input.ownerId ?? null,
    module,
    entity_type: entityType,
    entity_id: entityId,
    object_key: input.objectKey,
    provider: String(input.provider),
    filename,
    mime_type: mimeType,
    size_bytes: Math.max(0, Math.floor(input.size)),
    checksum_sha256: input.checksum ?? null,
    upload_status: status,
    version,
    is_current: 1,
    supersedes_id: supersedesId,
    classification,
    retention_policy: retentionPolicy,
    retention_expires_at: retentionExpiresAt,
    legal_hold: 0,
    created_by: input.ownerId ?? null,
  })

  // Stamp the human-readable ref now that we know the id, and retire the prior
  // current version (if any) in the same logical chain.
  await tenantUpdate(TABLE, { file_ref: formatFileRef(insertId) }, "id = ?", [insertId])
  if (supersedesId) {
    await tenantUpdate(TABLE, { is_current: 0 }, "id = ?", [supersedesId])
  }

  const created = await getFileById(insertId)
  return created!
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFileById(id: number): Promise<FileObject | null> {
  await ensureFileMetadataSchema()
  const { where, params } = scopedWhere(TABLE, "id = ?", [id])
  const rows = await query<FileObjectRow[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? toFileObject(rows[0]) : null
}

export async function getByObjectKey(objectKey: string): Promise<FileObject | null> {
  await ensureFileMetadataSchema()
  const { where, params } = scopedWhere(TABLE, "object_key = ?", [objectKey])
  const rows = await query<FileObjectRow[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? toFileObject(rows[0]) : null
}

export type ListFilesFilter = {
  module?: string
  entityType?: string
  entityId?: string | number
  status?: FileUploadStatus
  currentOnly?: boolean
  includeDeleted?: boolean
  limit?: number
}

/** List a tenant's files, filtered by module/entity/status. */
export async function listFileMetadata(filter: ListFilesFilter = {}): Promise<FileObject[]> {
  await ensureFileMetadataSchema()
  const clauses: string[] = []
  const params: any[] = []
  if (filter.module) {
    clauses.push("module = ?")
    params.push(filter.module)
  }
  if (filter.entityType) {
    clauses.push("entity_type = ?")
    params.push(filter.entityType)
  }
  if (filter.entityId != null) {
    clauses.push("entity_id = ?")
    params.push(String(filter.entityId))
  }
  if (filter.status) {
    clauses.push("upload_status = ?")
    params.push(filter.status)
  } else if (!filter.includeDeleted) {
    clauses.push("upload_status <> 'deleted'")
  }
  if (filter.currentOnly) clauses.push("is_current = 1")

  const { where, params: scoped } = scopedWhere(TABLE, clauses.join(" AND "), params)
  const limit = Math.max(1, Math.min(1000, filter.limit ?? 200))
  const rows = await query<FileObjectRow[]>(
    `SELECT * FROM ${TABLE} ${where} ORDER BY id DESC LIMIT ?`,
    [...scoped, limit],
  )
  return rows.map(toFileObject)
}

/** All versions of one logical file, newest first. */
export async function getVersionHistory(fileId: number): Promise<FileObject[]> {
  const file = await getFileById(fileId)
  if (!file || !file.entityType || !file.filename) return file ? [file] : []
  const { where, params } = scopedWhere(
    TABLE,
    "module = ? AND entity_type = ? AND (entity_id <=> ?) AND filename = ?",
    [file.module, file.entityType, file.entityId, file.filename],
  )
  const rows = await query<FileObjectRow[]>(
    `SELECT * FROM ${TABLE} ${where} ORDER BY version DESC`,
    params,
  )
  return rows.map(toFileObject)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Move a file to a new upload status (e.g. mark a pending upload completed/failed). */
export async function setUploadStatus(fileId: number, status: FileUploadStatus): Promise<boolean> {
  await ensureFileMetadataSchema()
  const result = await writeFileRecord({ upload_status: status }, fileId)
  return result.affectedRows > 0
}

/** Attach/refresh integrity + size after the bytes have landed. */
export async function setIntegrity(
  fileId: number,
  info: { checksum: string; size: number },
): Promise<boolean> {
  await ensureFileMetadataSchema()
  const affected = await tenantUpdate(
    TABLE,
    { checksum_sha256: info.checksum, size_bytes: Math.max(0, Math.floor(info.size)), upload_status: "completed" },
    "id = ?",
    [fileId],
  )
  return affected > 0
}

/** Toggle a legal hold, which blocks retention-driven deletion. */
export async function setLegalHold(fileId: number, hold: boolean): Promise<boolean> {
  await ensureFileMetadataSchema()
  const affected = await tenantUpdate(TABLE, { legal_hold: hold ? 1 : 0 }, "id = ?", [fileId])
  return affected > 0
}

/** Soft-delete: mark the metadata row deleted (audit trail preserved). */
export async function softDeleteFile(fileId: number, userId?: number | null): Promise<boolean> {
  await ensureFileMetadataSchema()
  const affected = await tenantUpdate(
    TABLE,
    {
      upload_status: "deleted",
      is_current: 0,
      deleted_at: new Date(),
      deleted_by: userId ?? null,
    },
    "id = ? AND legal_hold = 0",
    [fileId],
  )
  return affected > 0
}

/**
 * Files whose retention window has elapsed and are eligible for purge
 * (completed, not on legal hold, not already deleted). The caller deletes the
 * bytes from storage and then soft-deletes the metadata row.
 */
export async function findRetentionExpired(now: Date = new Date(), limit = 200): Promise<FileObject[]> {
  await ensureFileMetadataSchema()
  const { where, params } = scopedWhere(
    TABLE,
    "retention_expires_at IS NOT NULL AND retention_expires_at <= ? AND legal_hold = 0 AND upload_status = 'completed'",
    [now],
  )
  const rows = await query<FileObjectRow[]>(
    `SELECT * FROM ${TABLE} ${where} ORDER BY retention_expires_at ASC LIMIT ?`,
    [...params, Math.max(1, Math.min(1000, limit))],
  )
  return rows.map(toFileObject)
}

/** Aggregate storage footprint for the current tenant (live objects only). */
export async function getStorageUsage(): Promise<{ files: number; bytes: number }> {
  await ensureFileMetadataSchema()
  const { where, params } = scopedWhere(TABLE, "upload_status = 'completed' AND is_current = 1")
  const rows = await query<{ files: number; bytes: string | number }[]>(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM ${TABLE} ${where}`,
    params,
  )
  return { files: Number(rows[0]?.files ?? 0), bytes: Number(rows[0]?.bytes ?? 0) }
}

/** Guard: assert the current tenant owns this file object key. */
export function assertOwnsKey(objectKey: string): void {
  if (!keyBelongsToTenant(objectKey, currentTenantId())) {
    throw new CrossTenantAccessError("File not found")
  }
}

export { tenantIdFromKey }
export * from "./file-metadata-policy"
