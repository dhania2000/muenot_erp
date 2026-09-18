import "server-only"
import { currentTenantId, CrossTenantAccessError } from "@/lib/tenant-scope"
import { validateUpload } from "@/lib/settings/uploads"
import { getActiveConnection } from "./connection-store"
import { VercelBlobProvider } from "./vercel-blob"
import { S3StorageProvider } from "./s3"
import { tenantKey, tenantPrefix, keyBelongsToTenant } from "./keys"
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

export { tenantKey, tenantPrefix, keyBelongsToTenant, tenantIdFromKey } from "./keys"
export { providerFromConnection as buildProvider }
