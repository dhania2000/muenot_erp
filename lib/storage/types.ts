import type { StorageProviderId, ServerSideEncryptionMode } from "./providers"

/** A resolved storage connection (secrets decrypted, ready to use). */
export type ResolvedConnection = {
  id: number
  tenantId: number
  provider: StorageProviderId
  name: string
  bucket: string
  region: string | null
  endpoint: string | null
  accessKeyId: string | null
  secretAccessKey: string | null
  forcePathStyle: boolean
  /** Optional CDN/public base URL used to build direct links for public buckets. */
  publicBaseUrl: string | null
  /** SPEC 27 — object key prefix inside the bucket (e.g. "erp/prod"). */
  pathPrefix: string | null
  /** SPEC 27 — server-side encryption mode applied to uploaded objects. */
  serverSideEncryption: ServerSideEncryptionMode
  isActive: boolean
}

/** Result of a successful upload. */
export type UploadResult = {
  /** A URL the frontend can use to fetch the object (public URL or proxy path). */
  url: string
  /** The canonical, tenant-namespaced storage key. */
  key: string
  provider: StorageProviderId
  size: number
  contentType: string | null
}

export type StorageObjectMeta = {
  key: string
  size: number
  lastModified: string | null
}

export type DownloadResult = {
  body: ReadableStream<Uint8Array> | Buffer
  contentType: string | null
  size: number | null
}

/**
 * The uniform contract every storage backend implements. Callers (upload
 * routes, download proxy, admin tooling) depend only on this interface, never
 * on a specific vendor SDK.
 */
export interface StorageProvider {
  readonly id: StorageProviderId
  /** Upload bytes at `key`. `public` hints whether a direct URL is desired. */
  upload(key: string, data: Buffer, contentType: string, opts?: { public?: boolean }): Promise<UploadResult>
  /** Fetch an object for streaming back to the client. */
  download(key: string): Promise<DownloadResult>
  /** List objects under a key prefix (already tenant-namespaced by the caller). */
  list(prefix: string, opts?: { limit?: number }): Promise<StorageObjectMeta[]>
  /** Delete a single object. Idempotent. */
  delete(key: string): Promise<void>
  /** Lightweight connectivity/permission check used by the "Test connection" action. */
  healthCheck(): Promise<void>
}
