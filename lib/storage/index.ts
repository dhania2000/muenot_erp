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
import type { StorageProvider, UploadResult, ResolvedConnection, StorageObjectMeta, DownloadResult } from "./types"

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
 * Validate + upload a File to the tenant's active storage under a tenant-scoped
 * key. Drop-in replacement for the ad-hoc `put(...)` calls the upload routes
 * used before, but provider-agnostic and isolated.
 *
 * `path` is the logical path within the tenant namespace (e.g.
 * "finance-expenses/<uuid>-<name>"); it is sanitized and prefixed automatically.
 */
export async function uploadFile(
  path: string,
  file: File,
  opts: { public?: boolean; skipValidation?: boolean } = {},
): Promise<{ ok: true; result: UploadResult } | { ok: false; error: string }> {
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
    return { ok: true, result }
  } catch (err) {
    console.error("[v0] storage upload failed:", err)
    return { ok: false, error: "Upload failed. Check the connected storage configuration." }
  }
}

/** Download an object for the current tenant, enforcing key ownership. */
export async function downloadFile(key: string): Promise<DownloadResult> {
  const { provider } = await getTenantStorage()
  return provider.download(key)
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

/** Delete an object for the current tenant. */
export async function deleteFile(key: string): Promise<void> {
  const { provider } = await getTenantStorage()
  await provider.delete(key)
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

/** Finalize a session once every part has landed. */
export async function completeLargeUpload(
  sessionId: number,
): Promise<{ ok: true; key: string; result: UploadResult } | { ok: false; error: string; status?: number }> {
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
    return { ok: true, key: session.storage_key, result }
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
