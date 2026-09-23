import "server-only"
import { randomUUID } from "node:crypto"
import { query } from "@/lib/db"
import { currentTenantId, scopedWhere, tenantInsert } from "@/lib/tenant-scope"
import { getTenantStorage, downloadFile, getSignedDownloadUrl } from "./index"
import { tenantKey } from "./keys"
import {
  getFileById,
  getVersionHistory,
  recordFileMetadata,
  type FileObject,
} from "./file-metadata"

/**
 * File / document versioning.
 * ---------------------------------------------------------------------------
 * already models the *version chain* for a logical file inside
 * `file_objects` (version, is_current, supersedes_id): every re-upload of the
 * same (module, entity, filename) retires the prior current row and creates
 * version N+1. This module is the versioning *behaviour* on top of that model:
 *
 *   - list a file's full version history with WHO uploaded each version and WHEN,
 *     flagging the current one,
 *   - RESTORE any historical version (its stored bytes are copied to a fresh
 *     tenant key and recorded as a brand-new current version, so nothing is ever
 *     overwritten and the chain keeps growing forward),
 *   - hand out a short-lived signed URL to DOWNLOAD a specific historical version,
 *   - keep an append-only AUDIT trail of the version actions (restore/download)
 *     alongside the intrinsic upload metadata every version already carries.
 *
 * Everything is tenant-scoped through the helpers, so one tenant can
 * never see, restore, download or audit another tenant's file versions.
 */

const AUDIT_TABLE = "file_version_audit"

// ---------------------------------------------------------------------------
// Pure vocabulary + policy (unit-tested without a DB)
// ---------------------------------------------------------------------------

export type VersionAuditAction = "uploaded" | "restored" | "downloaded" | "deleted"

const AUDIT_ACTIONS: readonly VersionAuditAction[] = ["uploaded", "restored", "downloaded", "deleted"]

export function normalizeVersionAuditAction(value: string | null | undefined): VersionAuditAction {
  return AUDIT_ACTIONS.includes(value as VersionAuditAction) ? (value as VersionAuditAction) : "uploaded"
}

/** Human label for a version number, e.g. 3 → "v3". */
export function formatVersionLabel(version: number): string {
  return `v${Math.max(1, Math.floor(version))}`
}

/** A file supports versioning only when it is anchored to an entity + filename. */
export function supportsVersioning(file: Pick<FileObject, "entityType" | "filename">): boolean {
  return Boolean(file.entityType && file.filename)
}

export type RestoreActor = { userId: number; role: "admin" | "employee" }

/**
 * Restore permission. Admins can restore any of their tenant's file versions;
 * a non-admin may only restore a file they themselves uploaded/own. (Tenant
 * ownership is already guaranteed upstream by the tenant-scoped read.)
 */
export function canRestoreVersion(
  actor: RestoreActor,
  file: Pick<FileObject, "ownerId">,
): boolean {
  if (actor.role === "admin") return true
  return file.ownerId != null && Number(file.ownerId) === Number(actor.userId)
}

// ---------------------------------------------------------------------------
// Audit schema + writes
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

export function ensureFileVersionAuditSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      file_id BIGINT NOT NULL,
      file_ref VARCHAR(40) DEFAULT NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      action VARCHAR(20) NOT NULL,
      detail VARCHAR(500) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_fva_tenant (tenant_id),
      KEY idx_fva_file (tenant_id, file_id),
      KEY idx_fva_action (tenant_id, action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

/** Append a tenant-scoped version-audit entry. Never throws to the caller. */
export async function logFileVersionAudit(
  action: VersionAuditAction,
  entry: { fileId: number; fileRef?: string | null; version: number; detail?: string | null; userId?: number | null },
): Promise<void> {
  try {
    await ensureFileVersionAuditSchema()
    await tenantInsert(AUDIT_TABLE, {
      file_id: entry.fileId,
      file_ref: entry.fileRef ?? null,
      version: Math.max(1, Math.floor(entry.version)),
      action: normalizeVersionAuditAction(action),
      detail: entry.detail ? String(entry.detail).slice(0, 500) : null,
      user_id: entry.userId ?? null,
    })
  } catch (err) {
    console.error("[v0] file version audit write failed:", err)
  }
}

export type VersionAuditEntry = {
  id: number
  fileId: number
  fileRef: string | null
  version: number
  action: VersionAuditAction
  detail: string | null
  userId: number | null
  userName: string | null
  createdAt: string | null
}

/** Audit trail for every version in a logical file's chain, newest first. */
export async function listFileVersionAudit(fileIds: number[], limit = 100): Promise<VersionAuditEntry[]> {
  await ensureFileVersionAuditSchema()
  const ids = Array.from(new Set(fileIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)))
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(", ")
  const { where, params } = scopedWhere(AUDIT_TABLE, `file_id IN (${placeholders})`, ids)
  const rows = await query<any[]>(
    `SELECT id, file_id, file_ref, version, action, detail, user_id, created_at
       FROM ${AUDIT_TABLE} ${where} ORDER BY id DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(500, limit))],
  )
  const names = await resolveUserNames(rows.map((r) => r.user_id))
  return rows.map((r) => ({
    id: Number(r.id),
    fileId: Number(r.file_id),
    fileRef: r.file_ref ?? null,
    version: Number(r.version),
    action: normalizeVersionAuditAction(r.action),
    detail: r.detail ?? null,
    userId: r.user_id == null ? null : Number(r.user_id),
    userName: r.user_id == null ? null : names.get(Number(r.user_id)) ?? null,
    createdAt: r.created_at ? String(r.created_at) : null,
  }))
}

// ---------------------------------------------------------------------------
// Version history (enriched with uploader identity)
// ---------------------------------------------------------------------------

export type FileVersion = FileObject & { uploadedByName: string | null }

export type FileVersionHistory = {
  current: FileVersion | null
  versions: FileVersion[]
  audit: VersionAuditEntry[]
}

/**
 * Resolve a display name per user id, scoped to the current tenant. Missing or
 * cross-tenant ids simply drop out of the map (rendered as "—" by the UI).
 */
async function resolveUserNames(userIds: (number | null | undefined)[]): Promise<Map<number, string>> {
  const ids = Array.from(
    new Set(userIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)),
  )
  const map = new Map<number, string>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(", ")
  const rows = await query<any[]>(
    `SELECT id, name FROM users WHERE id IN (${placeholders}) AND tenant_id = ?`,
    [...ids, currentTenantId()],
  )
  for (const r of rows) map.set(Number(r.id), String(r.name ?? ""))
  return map
}

/**
 * Full version history for the logical file that `versionId` belongs to (any
 * version in the chain resolves the same history), newest first, with the
 * uploader name for each version and the action audit trail.
 */
export async function getFileVersionHistory(versionId: number): Promise<FileVersionHistory | null> {
  const anchor = await getFileById(versionId)
  if (!anchor) return null
  const history = await getVersionHistory(versionId)
  const names = await resolveUserNames(history.map((v) => v.ownerId))
  const versions: FileVersion[] = history.map((v) => ({
    ...v,
    uploadedByName: v.ownerId == null ? null : names.get(Number(v.ownerId)) ?? null,
  }))
  const current = versions.find((v) => v.isCurrent) ?? null
  const audit = await listFileVersionAudit(versions.map((v) => v.id))
  return { current, versions, audit }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function readToBuffer(body: ReadableStream<Uint8Array> | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

export type RestoreResult =
  | { ok: true; version: FileVersion; restoredFrom: number }
  | { ok: false; error: string; status: number }

/**
 * Restore a historical version. Its stored bytes are copied to a fresh
 * tenant-namespaced key and recorded as a NEW current version (version N+1),
 * so the restored content becomes current without ever overwriting or losing
 * any prior version. Records a "restored" audit entry.
 */
export async function restoreFileVersion(versionId: number, actor: RestoreActor): Promise<RestoreResult> {
  const target = await getFileById(versionId)
  if (!target) return { ok: false, error: "Version not found", status: 404 }
  if (!supportsVersioning(target)) {
    return { ok: false, error: "This file is not versioned and cannot be restored", status: 400 }
  }
  if (target.isCurrent) {
    return { ok: false, error: "That version is already the current version", status: 409 }
  }
  if (target.uploadStatus === "deleted") {
    return { ok: false, error: "A deleted version cannot be restored", status: 409 }
  }
  if (!canRestoreVersion(actor, target)) {
    return { ok: false, error: "You do not have permission to restore this file", status: 403 }
  }

  // Copy the historical bytes to a new key so every version keeps its own
  // immutable object (file_objects enforces one row per object key per tenant).
  let buffer: Buffer
  try {
    const src = await downloadFile(target.objectKey)
    buffer = await readToBuffer(src.body)
  } catch (err) {
    console.error("[v0] restore: source object download failed:", err)
    return { ok: false, error: "The stored bytes for that version are unavailable", status: 502 }
  }

  const contentType = target.mimeType || "application/octet-stream"
  const newKey = tenantKey(currentTenantId(), `${target.module}/versions/${randomUUID()}-${target.filename}`)
  const { provider } = await getTenantStorage()
  try {
    await provider.upload(newKey, buffer, contentType)
  } catch (err) {
    console.error("[v0] restore: re-upload failed:", err)
    return { ok: false, error: "Could not write the restored version", status: 502 }
  }

  let created: FileObject
  try {
    created = await recordFileMetadata({
      objectKey: newKey,
      provider: target.provider,
      module: target.module,
      entityType: target.entityType,
      entityId: target.entityId,
      filename: target.filename,
      mimeType: target.mimeType,
      size: buffer.length,
      checksum: target.checksum,
      ownerId: actor.userId,
      classification: target.classification,
      retentionPolicy: target.retentionPolicy,
      uploadStatus: "completed",
    })
  } catch (err) {
    console.error("[v0] restore: metadata record failed:", err)
    return { ok: false, error: "Could not record the restored version", status: 500 }
  }

  await logFileVersionAudit("restored", {
    fileId: created.id,
    fileRef: created.fileRef,
    version: created.version,
    userId: actor.userId,
    detail: `Restored ${formatVersionLabel(target.version)} (${target.fileRef}) as ${formatVersionLabel(created.version)}`,
  })

  const names = await resolveUserNames([created.ownerId])
  return {
    ok: true,
    restoredFrom: target.version,
    version: { ...created, uploadedByName: created.ownerId == null ? null : names.get(Number(created.ownerId)) ?? null },
  }
}

// ---------------------------------------------------------------------------
// Download a specific historical version
// ---------------------------------------------------------------------------

export type VersionDownloadResult =
  | { ok: true; url: string; filename: string | null; version: number }
  | { ok: false; error: string; status: number }

/** Issue a short-lived signed URL for one specific version, and audit it. */
export async function getVersionDownloadUrl(
  versionId: number,
  actor: { userId: number },
  opts: { expiresIn?: number } = {},
): Promise<VersionDownloadResult> {
  const target = await getFileById(versionId)
  if (!target) return { ok: false, error: "Version not found", status: 404 }
  if (target.uploadStatus === "deleted") {
    return { ok: false, error: "That version has been deleted", status: 409 }
  }
  let url: string
  try {
    url = await getSignedDownloadUrl(target.objectKey, { expiresIn: opts.expiresIn ?? 300 })
  } catch (err) {
    console.error("[v0] version download signing failed:", err)
    return { ok: false, error: "Could not sign the download link", status: 502 }
  }
  await logFileVersionAudit("downloaded", {
    fileId: target.id,
    fileRef: target.fileRef,
    version: target.version,
    userId: actor.userId,
    detail: `Downloaded ${formatVersionLabel(target.version)}`,
  })
  return { ok: true, url, filename: target.filename, version: target.version }
}
