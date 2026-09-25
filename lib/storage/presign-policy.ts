import { keyBelongsToTenant, sanitizePath } from "./keys"

/**
 * Pure decision logic for presigned uploads/downloads and multipart completion.
 * ---------------------------------------------------------------------------
 * Kept free of DB/SDK imports so every branch (idempotent replay, expiry,
 * cross-tenant keys, missing parts) is unit-tested directly; the server
 * orchestration in lib/storage/presigned.ts only wires I/O around these.
 */

export const DEFAULT_UPLOAD_URL_TTL_SECONDS = 300
export const MAX_UPLOAD_URL_TTL_SECONDS = 900
export const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 300
export const MAX_DOWNLOAD_URL_TTL_SECONDS = 3600

export function clampUploadTtl(ttl: unknown): number {
  const n = Number(ttl)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPLOAD_URL_TTL_SECONDS
  return Math.min(Math.floor(n), MAX_UPLOAD_URL_TTL_SECONDS)
}

export function clampDownloadTtl(ttl: unknown): number {
  const n = Number(ttl)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DOWNLOAD_URL_TTL_SECONDS
  return Math.min(Math.floor(n), MAX_DOWNLOAD_URL_TTL_SECONDS)
}

/**
 * True only when `key` is a canonical key inside `tenantId`'s namespace:
 * correct `t/<id>/` segment AND no traversal/empty/dot segments that could
 * alias another object (S3 keys are literal, but proxies and CDNs may not be).
 */
export function isSafeTenantKey(key: string, tenantId: number): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false
  if (/[\u0000-\u001f\\]/.test(key)) return false
  if (sanitizePath(key) !== key) return false
  return keyBelongsToTenant(key, tenantId)
}

/** Idempotency keys: opaque, bounded, printable. */
export function isValidIdempotencyKey(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}

export type PresignUploadRequest = {
  filename: string
  size: number
  contentType: string
  path: string
}

/** Canonical request fingerprint: a replay with a different body is a conflict. */
export function uploadRequestFingerprint(req: PresignUploadRequest): string {
  return JSON.stringify([req.path, req.filename, req.size, req.contentType]).slice(0, 700)
}

export type UploadIntentStatus = "pending" | "completed" | "expired"

export type UploadIntentLike = {
  status: UploadIntentStatus
  requestFingerprint: string
  expiresAt: string | Date
  connectionId: number | null
}

export type IntentReplayDecision =
  | { action: "create" }
  | { action: "reissue" }
  | { action: "replay_completed" }
  | { action: "conflict"; reason: string }

/**
 * Decide what a presign-upload request does given any intent already stored
 * under the same idempotency key.
 *  - none            → create a new intent
 *  - same body, pending, same connection → re-sign a fresh URL for the SAME key
 *  - same body, completed → return the completed result (no new URL)
 *  - different body  → 409 conflict (the key was reused for another file)
 */
export function decideIntentReplay(
  existing: UploadIntentLike | null,
  requestFingerprint: string,
  activeConnectionId: number | null,
): IntentReplayDecision {
  if (!existing) return { action: "create" }
  if (existing.requestFingerprint !== requestFingerprint) {
    return { action: "conflict", reason: "Idempotency key was already used for a different upload" }
  }
  if (existing.status === "completed") return { action: "replay_completed" }
  if (existing.connectionId !== activeConnectionId) {
    return { action: "conflict", reason: "The storage connection changed; start a new upload" }
  }
  return { action: "reissue" }
}

export type ObjectStat = { size: number; contentType: string | null } | null

export type IntentCompletionDecision =
  | { action: "complete" }
  | { action: "replay" }
  | { action: "reject"; status: number; error: string }

/**
 * Decide whether a direct-to-bucket upload can be finalized. The server never
 * trusts the client's "done": it HEADs the object and checks the size matches
 * what was authorized. An expired intent whose object never arrived is 410.
 */
export function decideIntentCompletion(
  intent: { status: UploadIntentStatus; declaredSize: number; expiresAt: string | Date },
  stat: ObjectStat,
  now: Date = new Date(),
): IntentCompletionDecision {
  if (intent.status === "completed") return { action: "replay" }
  if (!stat) {
    if (new Date(intent.expiresAt).getTime() <= now.getTime()) {
      return { action: "reject", status: 410, error: "The upload URL expired before the file arrived" }
    }
    return { action: "reject", status: 409, error: "The file has not been uploaded yet" }
  }
  if (stat.size !== intent.declaredSize) {
    return { action: "reject", status: 422, error: "Uploaded size does not match the authorized size" }
  }
  return { action: "complete" }
}

export type MultipartCompletionDecision =
  | { action: "complete"; partNumbers: number[] }
  | { action: "replay" }
  | { action: "reject"; status: number; error: string }

/**
 * Multipart completion gate. `parts` should be the provider's authoritative
 * listing when available (so parts uploaded straight to S3 via presigned part
 * URLs are counted), else the parts the server recorded.
 */
export function decideMultipartCompletion(input: {
  status: "active" | "completed" | "aborted"
  totalParts: number
  parts: { partNumber: number }[]
  connectionRevoked: boolean
}): MultipartCompletionDecision {
  if (input.status === "completed") return { action: "replay" }
  if (input.status === "aborted") return { action: "reject", status: 409, error: "Upload was cancelled" }
  if (input.connectionRevoked) {
    return { action: "reject", status: 409, error: "The storage connection for this upload was revoked" }
  }
  const unique = [...new Set(input.parts.map((p) => p.partNumber))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= input.totalParts)
    .sort((a, b) => a - b)
  if (unique.length < input.totalParts) {
    const have = new Set(unique)
    const missing: number[] = []
    for (let i = 1; i <= input.totalParts && missing.length < 10; i++) if (!have.has(i)) missing.push(i)
    return {
      action: "reject",
      status: 409,
      error: `Missing chunks: received ${unique.length} of ${input.totalParts} (missing ${missing.join(", ")}${
        input.totalParts - unique.length > missing.length ? ", …" : ""
      })`,
    }
  }
  return { action: "complete", partNumbers: unique }
}
