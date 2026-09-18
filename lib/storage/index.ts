import "server-only"
import { randomUUID } from "node:crypto"
import { currentTenantId, CrossTenantAccessError } from "@/lib/tenant-scope"
import { validateUpload, validateLargeUpload, getLargeUploadLimits } from "@/lib/settings/uploads"
import { getActiveConnection } from "./connection-store"
import { VercelBlobProvider } from "./vercel-blob"
import { S3StorageProvider } from "./s3"
import { tenantKey, tenantPrefix, keyBelongsToTenant } from "./keys"
import {
  createSession,
  getSession,
  recordPart,
  getParts,
  markCompleted,
  markAborted,
  getSessionStatus,
  type UploadCategory,
  type UploadSessionStatus,
} from "./multipart-store"
import { recordFileMetadata, getByObjectKey, softDeleteFile, sha256, type FileObject } from "./file-metadata"
import { enqueueScan, enforceDownloadPolicyForKey } from "./file-scanning"
import type {
  StorageProvider,
  UploadResult,
  ResolvedConnection,
  StorageObjectMeta,
  DownloadResult,
  DownloadOptions,
} from "./types"

/**
 * SPEC 26 — Storage facade.
 * ---------------------------------------------------------------------------
 * The one entry point the rest of the app uses. It resolves the ACTIVE storage
 * connection for the current tenant and returns a uniform provider; when a
 * tenant has connected their own S3-compatible bucket, uploads/downloads go
 * there, otherwise they fall back to the platform's Vercel Blob. Callers never
 * touch a vendor SDK or know which backend is in play.
 */

export function providerFromConnection(conn: ResolvedConnection | null): StorageProvider {
  if (conn && conn.provider !== "vercel_blob") return new S3StorageProvider(conn)
  return new VercelBlobProvider()
}

/** The active provider for the current tenant (their bucket, or the default). */
export async function getTenantStorage(): Promise<{ provider: StorageProvider; connection: ResolvedConnection | null }> {
  const connection = await getActiveConnection()
  return { provider: providerFromConnection(connection), connection }
}

async function toBuffer(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer())
}

/**
 * SPEC 32 — Optional centralized-metadata descriptor. When a caller passes this
 * to `uploadFile`, the storage facade records a normalized `file_objects` row
 * (tenant, owner, module, entity, key, provider, MIME, size, SHA-256, status,
 * version, retention, classification) alongside the physical upload — so every
 * module's files are auditable, integrity-checkable and retention-managed from
 * one place. Omit it and `uploadFile` behaves exactly as before (no row).
 */
export type FileMetadataInput = {
  module: string
  entityType?: string | null
  entityId?: string | number | null
  ownerId?: number | null
  classification?: string | null
  retentionPolicy?: string | null
}

/**
 * Validate + upload a File to the tenant's active storage under a tenant-scoped
 * key. Drop-in replacement for the ad-hoc `put(...)` calls the upload routes
 * used before, but provider-agnostic and isolated.
 *
 * `path` is the logical path within the tenant namespace (e.g.
 * "finance-expenses/<uuid>-<name>"); it is sanitized and prefixed automatically.
 *
 * When `opts.metadata` is provided, a SPEC 32 `file_objects` row is recorded and
 * returned as `result.file`. Metadata recording never fails the upload: if the
 * bytes landed but the metadata write throws, the upload still succeeds and the
 * error is logged.
 */
export async function uploadFile(
  path: string,
  file: File,
  opts: { public?: boolean; skipValidation?: boolean; metadata?: FileMetadataInput } = {},
): Promise<{ ok: true; result: UploadResult & { file?: FileObject } } | { ok: false; error: string }> {
  if (!opts.skipValidation) {
    const validationError = await validateUpload(file)
    if (validationError) return { ok: false, error: validationError }
  }
  const key = tenantKey(currentTenantId(), path)
  const { provider } = await getTenantStorage()
  const data = await toBuffer(file)
  const contentType = file.type || "application/octet-stream"
  try {
    const result = await provider.upload(key, data, contentType, { public: opts.public })
    if (!opts.metadata) return { ok: true, result }
    let recorded: FileObject | undefined
    try {
      recorded = await recordFileMetadata({
        objectKey: key,
        provider: result.provider,
        module: opts.metadata.module,
        entityType: opts.metadata.entityType ?? null,
        entityId: opts.metadata.entityId ?? null,
        filename: file.name,
        mimeType: contentType,
        size: result.size || data.length,
        checksum: sha256(data),
        ownerId: opts.metadata.ownerId ?? null,
        classification: opts.metadata.classification ?? null,
        retentionPolicy: opts.metadata.retentionPolicy ?? null,
        uploadStatus: "completed",
      })
    } catch (metaErr) {
      console.error("[v0] file metadata record failed (upload succeeded):", metaErr)
    }
    // SPEC 34 — kick off an asynchronous security scan for the new object.
    if (recorded) enqueueScan(recorded, { requestedBy: opts.metadata.ownerId ?? null })
    return { ok: true, result: { ...result, file: recorded } }
  } catch (err) {
    console.error("[v0] storage upload failed:", err)
    return { ok: false, error: "Upload failed. Check the connected storage configuration." }
  }
}

/** Download an object for the current tenant, enforcing key ownership. */
export async function downloadFile(key: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const { provider } = await getTenantStorage()
  return provider.download(key, opts)
}

const PROXY_MARKER = "/api/storage/file/"

/**
 * Resolve a value stored in a `storage_url` column, whichever form it takes,
 * into a streamable object. Backward compatible across:
 *   - legacy absolute URLs (public Vercel Blob links saved before SPEC 26),
 *   - the app's proxy path (/api/storage/file/<key>),
 *   - a bare tenant-namespaced key.
 * New rows store the key; old rows keep working unchanged.
 */
export async function openStoredObject(ref: string): Promise<DownloadResult> {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref)
    if (!res.ok || !res.body) throw new Error("Object unavailable")
    const len = Number(res.headers.get("content-length"))
    return { body: res.body, contentType: res.headers.get("content-type"), size: Number.isFinite(len) ? len : null }
  }
  let key = ref
  const idx = key.indexOf(PROXY_MARKER)
  if (idx >= 0) {
    key = key
      .slice(idx + PROXY_MARKER.length)
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s)
        } catch {
          return s
        }
      })
      .join("/")
  }
  return downloadFile(key)
}

/**
 * Delete an object for the current tenant. When a SPEC 32 metadata row exists
 * for the key it is soft-deleted (audit trail preserved) unless it is under a
 * legal hold, in which case the physical delete is skipped too.
 */
export async function deleteFile(key: string): Promise<void> {
  const existing = await getByObjectKey(key).catch(() => null)
  if (existing?.legalHold) {
    throw new Error("File is under a legal hold and cannot be deleted")
  }
  const { provider } = await getTenantStorage()
  await provider.delete(key)
  if (existing) await softDeleteFile(existing.id).catch(() => {})
}

/**
 * SPEC 29 — Issue a short-lived presigned URL for a stored object.
 *
 * This is the secure way to hand a file link to the browser (or embed one in a
 * PDF/email): permission + tenant ownership are validated HERE, before any URL
 * is minted, and the resulting URL expires quickly.
 *
 * - S3-compatible backends → a native presigned URL (bucket stays private).
 * - Managed Vercel Blob     → an HMAC-signed proxy URL.
 *
 * `ref` may be a bare key or the app's proxy path; absolute legacy URLs are
 * returned unchanged (nothing to sign). Throws CrossTenantAccessError when the
 * key does not belong to the current tenant.
 */
export async function getSignedDownloadUrl(ref: string, opts: { expiresIn?: number } = {}): Promise<string> {
  if (/^https?:\/\//i.test(ref)) return ref // legacy absolute URL — cannot presign
  const key = keyFromRef(ref)
  const tenantId = currentTenantId()
  if (!keyBelongsToTenant(key, tenantId)) throw new CrossTenantAccessError("File not found")
  // SPEC 34 — block the link if the object is quarantined / not yet cleared.
  await enforceDownloadPolicyForKey(key)
  const { provider } = await getTenantStorage()
  return provider.presign(key, opts)
}

/** Normalize a stored `storage_url` value (proxy path or bare key) to a key. */
function keyFromRef(ref: string): string {
  const idx = ref.indexOf(PROXY_MARKER)
  const raw = idx >= 0 ? ref.slice(idx + PROXY_MARKER.length) : ref
  // Drop any query string (a previously-signed URL) before decoding segments.
  const withoutQuery = raw.split("?")[0]
  return withoutQuery
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join("/")
}

/** List the current tenant's objects (always scoped to their key prefix). */
export async function listFiles(subPrefix = "", opts: { limit?: number } = {}): Promise<StorageObjectMeta[]> {
  const { provider } = await getTenantStorage()
  const prefix = tenantPrefix(currentTenantId()) + subPrefix.replace(/^\/+/, "")
  return provider.list(prefix, opts)
}

/**
 * SPEC 30 — Large / resumable multipart uploads.
 * ---------------------------------------------------------------------------
 * These four functions are the tenant-safe orchestration layer the API routes
 * call. They pair the active provider's native multipart primitives with the
 * session store so an upload can be resumed, retried per-chunk, cancelled, and
 * progress-tracked — while every key stays inside the tenant namespace and
 * ownership is re-checked on every part.
 */

const CATEGORIES: readonly UploadCategory[] = ["video", "image", "document", "zip", "training", "employee", "other"]

function normalizeCategory(value: string | null | undefined): UploadCategory {
  return CATEGORIES.includes(value as UploadCategory) ? (value as UploadCategory) : "other"
}

/** Begin a multipart upload: validate metadata, open a provider upload, persist a session. */
export async function beginLargeUpload(input: {
  path: string
  filename: string
  size: number
  contentType?: string | null
  category?: string | null
  userId?: number | null
}): Promise<
  | { ok: true; session: UploadSessionStatus; partSize: number; totalParts: number }
  | { ok: false; error: string }
> {
  const validationError = await validateLargeUpload({ name: input.filename, size: input.size })
  if (validationError) return { ok: false, error: validationError }

  const { partSize } = await getLargeUploadLimits()
  const totalParts = Math.max(1, Math.ceil(input.size / partSize))
  const contentType = input.contentType || "application/octet-stream"

  // Namespace the object under the tenant + a UUID so two uploads of the same
  // filename never collide and the key can never escape the tenant prefix.
  const safeName = input.path.replace(/^\/+/, "")
  const key = tenantKey(currentTenantId(), `${safeName}/${randomUUID()}`)

  const { provider } = await getTenantStorage()
  try {
    const handle = await provider.createMultipart(key, contentType)
    const sessionId = await createSession({
      uploadId: handle.uploadId,
      storageKey: key,
      provider: provider.id,
      filename: input.filename,
      contentType,
      totalSize: input.size,
      partSize,
      totalParts,
      category: normalizeCategory(input.category),
      userId: input.userId,
    })
    const status = await getSessionStatus(sessionId)
    if (!status) return { ok: false, error: "Failed to open upload session" }
    return { ok: true, session: status, partSize, totalParts }
  } catch (err) {
    console.error("[v0] beginLargeUpload failed:", err)
    return { ok: false, error: "Could not start the upload. Check the connected storage configuration." }
  }
}

/** Upload a single chunk into an active session and record it (idempotent). */
export async function uploadLargePart(
  sessionId: number,
  partNumber: number,
  data: Buffer,
): Promise<{ ok: true; uploadedParts: number[] } | { ok: false; error: string; status?: number }> {
  const session = await getSession(sessionId)
  if (!session) return { ok: false, error: "Upload session not found", status: 404 }
  if (session.status !== "active") return { ok: false, error: "Upload is no longer active", status: 409 }
  if (!keyBelongsToTenant(session.storage_key, currentTenantId()))
    return { ok: false, error: "File not found", status: 404 }
  if (partNumber < 1 || partNumber > session.total_parts)
    return { ok: false, error: "Invalid part number", status: 400 }

  const { provider } = await getTenantStorage()
  try {
    const part = await provider.uploadPart(session.storage_key, session.upload_id, partNumber, data)
    await recordPart(sessionId, { ...part, size: data.length })
    const parts = await getParts(sessionId)
    return { ok: true, uploadedParts: parts.map((p) => p.partNumber) }
  } catch (err) {
    console.error("[v0] uploadLargePart failed:", err)
    return { ok: false, error: "Chunk upload failed. Retry this part.", status: 502 }
  }
}

/**
 * Finalize a session once every part has landed. When `metadata` is provided a
 * SPEC 32 `file_objects` row is recorded for the assembled object. Large
 * multipart objects are never buffered server-side, so their checksum is left
 * null (integrity for these relies on the provider's per-part ETags); size,
 * provider and key are recorded from the session/result.
 */
export async function completeLargeUpload(
  sessionId: number,
  opts: { metadata?: FileMetadataInput } = {},
): Promise<
  | { ok: true; key: string; result: UploadResult & { file?: FileObject } }
  | { ok: false; error: string; status?: number }
> {
  const session = await getSession(sessionId)
  if (!session) return { ok: false, error: "Upload session not found", status: 404 }
  if (!keyBelongsToTenant(session.storage_key, currentTenantId()))
    return { ok: false, error: "File not found", status: 404 }
  if (session.status === "completed") {
    return { ok: false, error: "Upload already completed", status: 409 }
  }

  const parts = await getParts(sessionId)
  if (parts.length < session.total_parts) {
    return {
      ok: false,
      error: `Missing chunks: received ${parts.length} of ${session.total_parts}`,
      status: 409,
    }
  }

  const { provider } = await getTenantStorage()
  try {
    const result = await provider.completeMultipart(
      session.storage_key,
      session.upload_id,
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    )
    await markCompleted(sessionId)
    let recorded: FileObject | undefined
    if (opts.metadata) {
      try {
        recorded = await recordFileMetadata({
          objectKey: session.storage_key,
          provider: result.provider,
          module: opts.metadata.module,
          entityType: opts.metadata.entityType ?? null,
          entityId: opts.metadata.entityId ?? null,
          filename: session.filename,
          mimeType: session.content_type,
          size: result.size || Number(session.total_size),
          checksum: null,
          ownerId: opts.metadata.ownerId ?? session.created_by,
          classification: opts.metadata.classification ?? null,
          retentionPolicy: opts.metadata.retentionPolicy ?? null,
          uploadStatus: "completed",
        })
      } catch (metaErr) {
        console.error("[v0] file metadata record failed (multipart upload succeeded):", metaErr)
      }
    }
    return { ok: true, key: session.storage_key, result: { ...result, file: recorded } }
  } catch (err) {
    console.error("[v0] completeLargeUpload failed:", err)
    return { ok: false, error: "Could not finalize the upload.", status: 502 }
  }
}

/** Cancel a session: abort the provider upload and mark the session aborted. */
export async function abortLargeUpload(
  sessionId: number,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const session = await getSession(sessionId)
  if (!session) return { ok: false, error: "Upload session not found", status: 404 }
  if (!keyBelongsToTenant(session.storage_key, currentTenantId()))
    return { ok: false, error: "File not found", status: 404 }

  const { provider } = await getTenantStorage()
  try {
    await provider.abortMultipart(session.storage_key, session.upload_id)
  } catch (err) {
    console.error("[v0] abortLargeUpload provider abort failed (continuing):", err)
  }
  await markAborted(sessionId)
  return { ok: true }
}

export { tenantKey, tenantPrefix, keyBelongsToTenant, tenantIdFromKey } from "./keys"
export { providerFromConnection as buildProvider }
// SPEC 32 — Centralized file metadata (model, lifecycle, integrity, retention).
export {
  ensureFileMetadataSchema,
  recordFileMetadata,
  getFileById,
  getByObjectKey,
  listFileMetadata,
  getVersionHistory,
  setUploadStatus,
  setIntegrity,
  setLegalHold,
  softDeleteFile,
  findRetentionExpired,
  getStorageUsage,
  sha256,
  checksumMatches,
  formatFileRef,
  type FileObject,
  type FileUploadStatus,
} from "./file-metadata"
export {
  CLASSIFICATION_OPTIONS,
  RETENTION_OPTIONS,
  normalizeClassification,
  normalizeRetentionPolicy,
  computeRetentionExpiry,
  isRetentionExpired,
  type FileClassification,
  type RetentionPolicyId,
} from "./file-metadata-policy"
// SPEC 33 — File / document versioning (history, restore, download, audit).
export {
  getFileVersionHistory,
  restoreFileVersion,
  getVersionDownloadUrl,
  listFileVersionAudit,
  logFileVersionAudit,
  ensureFileVersionAuditSchema,
  canRestoreVersion,
  supportsVersioning,
  formatVersionLabel,
  normalizeVersionAuditAction,
  type FileVersion,
  type FileVersionHistory,
  type VersionAuditEntry,
  type VersionAuditAction,
  type RestoreActor,
} from "./file-versions"
// SPEC 31 — CDN / media-delivery policy helpers.
export {
  mediaKindFor,
  cacheControlFor,
  contentDispositionFor,
  cdnMaxAge,
  isRangeable,
  filenameFromKey,
  type MediaKind,
  type DeliveryAccess,
} from "./cdn"
