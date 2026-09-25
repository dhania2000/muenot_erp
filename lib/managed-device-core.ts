/**
 * Managed-device protection — pure, testable core (Spec25 · #214).
 * ---------------------------------------------------------------------------
 * A tenant may require that access come from a MANAGED device. A managed device
 * proves itself with a VERIFIED DEVICE ASSERTION rather than a spoofable
 * user-agent string: at enrollment the server issues the device a signed
 * assertion token bound to a stable device id; on each sign-in the client
 * presents that token and the server verifies the signature, expiry, and that
 * the device is still enrolled (not revoked).
 *
 * This module is the DB-free crypto/decision core:
 *   - deterministic device-id derivation,
 *   - HMAC-signed assertion token encode / verify (structure + signature + TTL),
 *   - the pure managed-device access decision (require ⇒ must be verified &
 *     active), with a fail-safe posture the store layers emergency access onto.
 *
 * The token is an HMAC (not a bearer secret stored server-side) so the server
 * only needs the enrollment record + the signing secret to verify it — the
 * assertion itself is stateless and tamper-evident. Verification is
 * constant-time to avoid signature timing oracles.
 *
 * No `server-only`, DB, or framework import — only Node's `crypto`, which is
 * available in every server runtime and unit-testable directly.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto"

/** Default assertion lifetime: long enough to be practical, short enough to rotate. */
export const DEFAULT_ASSERTION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
export const ASSERTION_VERSION = "v1"

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

/** Generate a fresh, opaque device id to bind an enrollment + its assertions to. */
export function newDeviceId(): string {
  return randomBytes(16).toString("hex")
}

export type AssertionClaims = {
  deviceId: string
  tenantId: number
  userId: number
  /** issued-at (unix seconds) */
  iat: number
  /** expires-at (unix seconds) */
  exp: number
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

/**
 * Build a signed device-assertion token: `v1.<payload>.<sig>` where payload is
 * base64url(JSON(claims)) and sig is HMAC-SHA256 over `v1.<payload>`.
 */
export function issueAssertion(
  input: { deviceId: string; tenantId: number; userId: number; ttlSeconds?: number },
  secret: string,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000)
  const ttl = input.ttlSeconds && input.ttlSeconds > 0 ? Math.floor(input.ttlSeconds) : DEFAULT_ASSERTION_TTL_SECONDS
  const claims: AssertionClaims = {
    deviceId: input.deviceId,
    tenantId: input.tenantId,
    userId: input.userId,
    iat,
    exp: iat + ttl,
  }
  const payload = b64url(JSON.stringify(claims))
  const signingInput = `${ASSERTION_VERSION}.${payload}`
  return `${signingInput}.${sign(signingInput, secret)}`
}

export type AssertionVerifyResult =
  | { ok: true; claims: AssertionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" }

/**
 * Verify an assertion token's structure, HMAC signature, and expiry. Does NOT
 * consult the DB — the caller must additionally confirm the device is still
 * enrolled and not revoked (that liveness check is what makes revocation take
 * effect). Signature comparison is constant-time.
 */
export function verifyAssertion(token: unknown, secret: string, now: Date = new Date()): AssertionVerifyResult {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" }
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed" }
  const [version, payload, sig] = parts
  if (version !== ASSERTION_VERSION || !payload || !sig) return { ok: false, reason: "malformed" }

  const expected = sign(`${version}.${payload}`, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" }

  let claims: AssertionClaims
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (
    typeof claims?.deviceId !== "string" ||
    typeof claims?.tenantId !== "number" ||
    typeof claims?.userId !== "number" ||
    typeof claims?.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" }
  }
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" }
  return { ok: true, claims }
}

export type DeviceState = "verified" | "revoked" | "unknown"

export type ManagedDevicePolicy = {
  /** When false the tenant does not require managed devices — access is unaffected. */
  required: boolean
}

export type ManagedDeviceDecision = {
  denied: boolean
  reason:
    | "policy_not_required"
    | "device_verified"
    | "assertion_missing"
    | "assertion_invalid"
    | "device_revoked"
}

/**
 * Pure managed-device access decision. `state` is the outcome of verifying the
 * presented assertion AND confirming enrollment liveness against the store:
 *   - "verified": assertion valid AND device still enrolled/active,
 *   - "revoked":  a matching device exists but has been revoked,
 *   - "unknown":  no valid assertion / no matching active enrollment.
 *
 * When the policy does not require managed devices, access is never denied here.
 * Emergency access is applied by the caller (store), not this core.
 */
export function evaluateManagedDevice(policy: ManagedDevicePolicy, state: DeviceState): ManagedDeviceDecision {
  if (!policy.required) return { denied: false, reason: "policy_not_required" }
  if (state === "verified") return { denied: false, reason: "device_verified" }
  if (state === "revoked") return { denied: true, reason: "device_revoked" }
  return { denied: true, reason: "assertion_missing" }
}
