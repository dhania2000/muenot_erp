import "server-only"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/**
 * Token encryption for stored OAuth credentials.
 *
 * Reuses the SAME AES-256-GCM scheme and the SAME `SETTINGS_ENCRYPTION_KEY`
 * already used by the admin environment-variables store
 * (app/api/admin/environment-variables/route.ts) so we do not introduce a
 * second, incompatible crypto system.
 *
 * Backward compatible: values are stored with an `enc:v1:` marker prefix when
 * encryption is available. Any value WITHOUT the marker (e.g. tokens saved by
 * an older build, or when no key is configured) is treated as plaintext and
 * returned as-is. If no key is configured we store plaintext rather than
 * failing the connection — the encryption is defense-in-depth, not a hard
 * dependency of the OAuth flow.
 */

const MARKER = "enc:v1:"

function key(): Buffer | null {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY
  if (!secret) return null
  return createHash("sha256").update(secret).digest()
}

export function encryptToken(value: string | null | undefined): string | null {
  if (value == null || value === "") return value ?? null
  const k = key()
  if (!k) return value // no key configured — store as-is
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", k, iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  return MARKER + payload.toString("base64")
}

export function decryptToken(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!value.startsWith(MARKER)) return value // legacy/plaintext value
  const k = key()
  if (!k) return null // marked encrypted but no key to decrypt with
  try {
    const payload = Buffer.from(value.slice(MARKER.length), "base64")
    if (payload.length < 28) return null
    const decipher = createDecipheriv("aes-256-gcm", k, payload.subarray(0, 12))
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
