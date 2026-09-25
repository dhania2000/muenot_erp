import "server-only"
/**
 * Shared webhook signing + verification.
 * ---------------------------------------------------------------------------
 * Both the sender (lib/webhooks/dispatcher.ts) and any inbound verifier / test
 * console use this single implementation so the signature scheme can never
 * drift between producing and checking a signature.
 *
 * Scheme: `X-Webhook-Signature` is an HMAC-SHA256, hex-encoded, of the exact
 * string `${timestamp}.${body}` using the endpoint's own signing secret.
 * `X-Webhook-Timestamp` carries the unix-second timestamp that was signed, so a
 * receiver can both (a) recompute the HMAC over the same preimage and (b)
 * reject stale timestamps to defeat replay of a captured, validly-signed body.
 */
import crypto from "crypto"

/** Default tolerance for how old a signed timestamp may be before it is treated as a replay. */
export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
}

/** Constant-time comparison of two hex signatures of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: "bad_signature" | "stale_timestamp" | "malformed" }

/**
 * Verify a received webhook. Fails closed:
 *   - `malformed`      — missing/invalid signature or timestamp inputs.
 *   - `stale_timestamp`— timestamp is outside the tolerance window (replay).
 *   - `bad_signature`  — HMAC does not match (forged or tampered body).
 *
 * The timestamp check runs BEFORE the HMAC compare so a captured-but-valid
 * payload replayed after the window is rejected even though its signature is
 * genuine.
 */
export function verifyWebhookSignature(input: {
  secret: string
  timestamp: string | null | undefined
  body: string
  signature: string | null | undefined
  toleranceSeconds?: number
  now?: number
}): VerifyWebhookResult {
  const { secret, timestamp, body, signature } = input
  if (!secret || !timestamp || !signature) return { ok: false, reason: "malformed" }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" }

  const tolerance = input.toleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000)
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: "stale_timestamp" }

  const expected = signWebhook(secret, timestamp, body)
  if (!safeEqualHex(expected, signature)) return { ok: false, reason: "bad_signature" }
  return { ok: true }
}
