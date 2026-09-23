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
  /** object key prefix inside the bucket (e.g. "erp/prod"). */
  pathPrefix: string | null
  /** server-side encryption mode applied to uploaded objects. */
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

/**
 * One uploaded chunk of a multipart upload. `etag` is the provider's
 * opaque part identifier (S3 ETag / Blob part etag) that MUST be replayed back
 * at completion time, so it is persisted in the upload session.
 */
export type MultipartPart = {
  partNumber: number
  etag: string
}

/**
 * Opaque handle for an in-progress multipart upload. `uploadId` is
 * whatever the backend needs to resume the upload across separate, stateless
 * requests (for Vercel Blob it also encodes the blob key), so callers persist
 * it verbatim and never interpret it.
 */
export type MultipartHandle = {
  uploadId: string
}

/**
 * Options for a download. `range` is a raw HTTP `Range` header value
 * (e.g. "bytes=0-1023"); providers that support it stream only the requested
 * slice so video/audio can be seeked and CDNs can do partial fetches.
 */
export type DownloadOptions = {
  range?: string | null
}

export type DownloadResult = {
  body: ReadableStream<Uint8Array> | Buffer
  contentType: string | null
  size: number | null
  /** validators/metadata used for CDN caching and Range delivery. */
  /** Total size of the underlying object (even for a partial response). */
  totalSize?: number | null
  /** Entity tag for conditional requests / cache validation, if known. */
  etag?: string | null
  /** Last-Modified timestamp (ISO or HTTP-date), if known. */
  lastModified?: string | null
  /** True when this body is a partial (Range) response. */
  isPartial?: boolean
  /** `Content-Range` header value when `isPartial` is true. */
  contentRange?: string | null
}

/**
 * Storage provider health check.
 * ---------------------------------------------------------------------------
 * The "Test connection" action runs a battery of individual probes instead of
 * one opaque call, so an admin can see exactly which capability is broken.
 */
export type HealthCheckId =
  | "connectivity"
  | "credentials"
  | "bucket"
  | "write"
  | "read"
  | "delete"
  | "multipart"

export type HealthCheckStatus = "pass" | "fail" | "skip"

export type HealthCheckResult = {
  id: HealthCheckId
  /** Human label for the UI (e.g. "Bucket access"). */
  label: string
  status: HealthCheckStatus
  /** Actionable detail — what happened, or why a check was skipped. */
  detail: string | null
  /** Wall-clock duration of the probe in milliseconds. */
  durationMs: number
}

export type HealthReport = {
  /** True when no check failed (skips are allowed). */
  ok: boolean
  checks: HealthCheckResult[]
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
  /**
   * Fetch an object for streaming back to the client. when `opts.range`
   * is provided the provider SHOULD return only that byte slice (with
   * `isPartial`/`contentRange` set); providers that cannot serve a range simply
   * ignore it and return the full object.
   */
  download(key: string, opts?: DownloadOptions): Promise<DownloadResult>
  /** List objects under a key prefix (already tenant-namespaced by the caller). */
  list(prefix: string, opts?: { limit?: number }): Promise<StorageObjectMeta[]>
  /** Delete a single object. Idempotent. */
  delete(key: string): Promise<void>
  /**
   * Issue a short-lived, presigned URL that grants read access to a
   * single object without exposing it publicly. S3-compatible backends return
   * a NATIVE presigned URL; the managed proxy backend returns an HMAC-signed
   * proxy path. Callers MUST validate session + tenant ownership of `key`
   * before calling this — the returned URL is itself the capability.
   */
  presign(key: string, opts?: { expiresIn?: number }): Promise<string>
  /**
   * Begin a resumable, chunked (multipart) upload for large files
   * (videos, ZIPs, training/employee bundles) that cannot be sent in a single
   * request. Returns an opaque handle the caller persists in an upload session.
   */
  createMultipart(key: string, contentType: string, opts?: { public?: boolean }): Promise<MultipartHandle>
  /**
   * Upload a single 1-based part. Returns the part's identifier which
   * MUST be stored and replayed at completion. Re-uploading the same
   * `partNumber` is safe (it overwrites), which is what powers failed-chunk
   * retry and resume.
   */
  uploadPart(key: string, uploadId: string, partNumber: number, data: Buffer): Promise<MultipartPart>
  /**
   * Assemble all previously-uploaded parts into the final object.
   * Parts may be passed in any order; implementations sort by `partNumber`.
   */
  completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<UploadResult>
  /** Abort an in-progress multipart upload and release its parts. */
  abortMultipart(key: string, uploadId: string): Promise<void>
  /** Lightweight connectivity/permission check (throws on failure). */
  healthCheck(): Promise<void>
  /**
   * Full diagnostic run for the "Test connection" action. Never
   * throws for expected failures; every probe is reported as pass/fail/skip.
   */
  diagnose(): Promise<HealthReport>
}
