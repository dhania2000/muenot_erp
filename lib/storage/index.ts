import "server-only"
import { currentTenantId } from "@/lib/tenant-scope"
import { validateUpload } from "@/lib/settings/uploads"
import { getActiveConnection } from "./connection-store"
import { VercelBlobProvider } from "./vercel-blob"
import { S3StorageProvider } from "./s3"
import { tenantKey, tenantPrefix } from "./keys"
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

/** List the current tenant's objects (always scoped to their key prefix). */
export async function listFiles(subPrefix = "", opts: { limit?: number } = {}): Promise<StorageObjectMeta[]> {
  const { provider } = await getTenantStorage()
  const prefix = tenantPrefix(currentTenantId()) + subPrefix.replace(/^\/+/, "")
  return provider.list(prefix, opts)
}

export { tenantKey, tenantPrefix, keyBelongsToTenant, tenantIdFromKey } from "./keys"
export { providerFromConnection as buildProvider }
