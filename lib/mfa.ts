/**
 * TOTP multi-factor authentication (RFC 4226 HOTP / RFC 6238 TOTP).
 * ---------------------------------------------------------------------------
 * Implemented with node's `crypto` alone — no extra dependency — so it is fully
 * deterministic and unit-testable (see test/user-lifecycle.test.ts, which
 * checks it against the RFC 6238 published test vectors). The secret is a
 * standard base32 string compatible with Google Authenticator, 1Password, Authy
 * and any other authenticator app via the returned otpauth:// URL.
 *
 * This module is pure (no DB, no `server-only`): storage of the secret and the
 * hashed backup codes lives in lib/user-lifecycle.ts.
 */
import crypto from "crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Encode raw bytes as RFC 4648 base32 (no padding), the authenticator format. */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

/** Decode an RFC 4648 base32 string (padding / whitespace / case tolerant). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/,"").replace(/\s+/g, "")
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** Generate a new random base32 TOTP secret (default 20 bytes → 160 bits). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes))
}

/** RFC 4226 HOTP for a given counter. */
export function hotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  // Write the 64-bit counter big-endian. Use BigInt to be exact past 2^32.
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac("sha1", key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const otp = binary % 10 ** digits
  return otp.toString().padStart(digits, "0")
}

/** RFC 6238 TOTP for a point in time (default 30s step, 6 digits). */
export function totp(secret: string, atMs: number = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds)
  return hotp(secret, counter, digits)
}

/**
 * Verify a user-supplied token against the secret, tolerating a ± `window`
 * step drift (default 1 → the previous, current and next 30s windows) so a
 * clock a little out of sync still works. Uses a length-safe comparison.
 */
export function verifyTotp(
  secret: string,
  token: string,
  opts: { atMs?: number; stepSeconds?: number; digits?: number; window?: number } = {},
): boolean {
  return matchedTotpStep(secret, token, opts) !== null
}

/** Return the exact accepted time-step so callers can reject replayed codes. */
export function matchedTotpStep(
  secret: string,
  token: string,
  opts: { atMs?: number; stepSeconds?: number; digits?: number; window?: number } = {},
): number | null {
  const { atMs = Date.now(), stepSeconds = 30, digits = 6, window = 1 } = opts
  const cleaned = (token || "").replace(/\s+/g, "")
  if (!/^\d+$/.test(cleaned) || cleaned.length !== digits) return null
  const counter = Math.floor(atMs / 1000 / stepSeconds)
  for (let error = -window; error <= window; error++) {
    const candidate = hotp(secret, counter + error, digits)
    if (timingSafeEqualStr(candidate, cleaned)) return counter + error
  }
  return null
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Build the otpauth:// URL an authenticator app scans as a QR code.
 * `label` is usually the user's email; `issuer` the product name.
 */
export function buildOtpAuthUrl(secret: string, label: string, issuer: string): string {
  const enc = encodeURIComponent
  const acct = `${enc(issuer)}:${enc(label)}`
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" })
  return `otpauth://totp/${acct}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Backup / recovery codes
// ---------------------------------------------------------------------------

/** Generate `count` human-friendly one-time recovery codes (e.g. "4f2a-9c1b"). */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString("hex") // 8 hex chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`)
  }
  return codes
}

/** Normalize a backup code for storage/compare (lowercase, no separators). */
export function normalizeBackupCode(code: string): string {
  return (code || "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** SHA-256 of a normalized backup code — codes are stored hashed, never raw. */
export function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex")
}
