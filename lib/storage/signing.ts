import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { tenantIdFromKey } from "./keys"

/**
 * Signed, short-lived access tokens for the download proxy.
 * ---------------------------------------------------------------------------
 * Objects on the tenant's own S3 backend get NATIVE presigned URLs (see
 * S3StorageProvider.presign). Objects served through the app proxy — the
 * managed Vercel Blob backend, and any embedded/cookieless context (PDF
 * renderers, <img> tags, email links) — get an HMAC-signed URL instead:
 *
 *     /api/storage/file/<key>?exp=<epoch>&sig=<hmac>
 *
 * The signature covers BOTH the exact object key and the expiry, so a token:
 *   - authorizes exactly one object (object-level access control),
 *   - is bound to one tenant, because the key is `t/<tenantId>/...` and the
 *     tenant segment is part of the signed material (tenant validation),
 *   - stops working after `exp` (short expiration).
 *
 * The token is only ever minted server-side AFTER the caller's session and
 * tenant ownership have been validated, so possession of a valid token is the
 * capability — exactly like a cloud presigned URL.
 */

/** Default lifetime for a signed proxy URL. Deliberately short. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300 // 5 minutes
/** Hard ceiling so a caller can never mint a effectively-permanent link. */
const MAX_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 // 24 hours

function signingSecret(): string {
  // Reuse the session secret so there is one key to rotate. The insecure dev
  // fallback mirrors lib/auth.ts and must never be relied on in production.
  return process.env.STORAGE_URL_SIGNING_SECRET || process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
}

/** base64url without padding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function computeSignature(key: string, exp: number): string {
  // The tenant id is part of `key` (t/<id>/...), so signing the raw key binds
  // the token to both the object AND the tenant with no extra field to forge.
  return b64url(createHmac("sha256", signingSecret()).update(`${key}\n${exp}`).digest())
}

/** Clamp a requested TTL into the allowed range. */
export function clampTtl(ttlSeconds: number | undefined): number {
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds as number) : DEFAULT_SIGNED_URL_TTL_SECONDS
  if (ttl <= 0) return DEFAULT_SIGNED_URL_TTL_SECONDS
  return Math.min(ttl, MAX_SIGNED_URL_TTL_SECONDS)
}

/** Encode a key into the proxy path (each segment URL-encoded). */
function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}

/**
 * Build a signed, expiring proxy URL for `key`. Callers MUST have already
 * validated that the current session may read this key.
 */
export function signedProxyUrl(key: string, ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + clampTtl(ttlSeconds)
  const sig = computeSignature(key, exp)
  return `/api/storage/file/${encodeKeyPath(key)}?exp=${exp}&sig=${encodeURIComponent(sig)}`
}

export type SignedTokenVerification =
  | { valid: true; tenantId: number }
  | { valid: false; reason: "malformed" | "expired" | "bad-signature" | "no-tenant" }

/**
 * Verify a signed proxy token against the exact key being requested. Returns
 * the tenant the token is bound to on success so the proxy can populate scope.
 */
export function verifySignedProxyToken(key: string, exp: string | null, sig: string | null): SignedTokenVerification {
  if (!exp || !sig) return { valid: false, reason: "malformed" }
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum <= 0) return { valid: false, reason: "malformed" }
  if (Math.floor(Date.now() / 1000) > expNum) return { valid: false, reason: "expired" }

  const expected = computeSignature(key, expNum)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad-signature" }

  const tenantId = tenantIdFromKey(key)
  if (tenantId == null) return { valid: false, reason: "no-tenant" }
  return { valid: true, tenantId }
}
