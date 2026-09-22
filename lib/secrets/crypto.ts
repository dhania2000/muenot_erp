import "server-only"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/**
 * SPEC 38 — Secret management. PHASE 2: encryption at rest.
 * ---------------------------------------------------------------------------
 * AES-256-GCM with a key derived from `SETTINGS_ENCRYPTION_KEY` — the SAME
 * master key and scheme the config/env-var stores already use, so we never
 * introduce a second, incompatible crypto system.
 *
 * Envelope: `sec:v1:` + base64(iv[12] | authTag[16] | ciphertext). The version
 * marker lets a future re-key migrate old envelopes without ambiguity.
 *
 * Unlike the best-effort OAuth token crypto, secret management REQUIRES a key:
 * writing an unencrypted secret to the managed store would defeat the whole
 * point, so `encryptSecret` throws when no key is configured rather than
 * silently storing plaintext. Callers surface that as a clear operator error.
 */

const MARKER = "sec:v1:"

function masterKey(): Buffer {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY
  if (!secret) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured")
  return createHash("sha256").update(secret).digest()
}

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.SETTINGS_ENCRYPTION_KEY)
}

/**
 * A short, non-reversible fingerprint of the master key. Stored alongside each
 * encrypted version so the console can show WHICH key era encrypted a value
 * (and flag envelopes that predate a re-key) without ever revealing the key.
 */
export function keyFingerprint(): string {
  return createHash("sha256").update(masterKey()).digest("hex").slice(0, 12)
}

export function encryptSecret(value: string): string {
  if (typeof value !== "string" || value === "") throw new Error("Cannot encrypt an empty secret")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  return MARKER + payload.toString("base64")
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(MARKER)) return null
  try {
    const encoded = value.slice(MARKER.length)
    const payload = Buffer.from(encoded, "base64")
    if (payload.length < 28) return null
    // Reject non-canonical base64: Node's decoder silently ignores stray
    // padding/alignment bits, so a mutation confined to those bits would decode
    // to identical bytes and slip past GCM's auth tag. Re-encoding and
    // comparing makes any such tampering fail closed.
    if (payload.toString("base64") !== encoded) return null
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), payload.subarray(0, 12))
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
