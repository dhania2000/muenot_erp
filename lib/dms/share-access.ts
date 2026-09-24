import "server-only"
/**
 * SPEC 89 — signed access primitives for secure document sharing.
 * ---------------------------------------------------------------------------
 * Two independent secrets protect a share link:
 *   1. The share TOKEN itself — a long unguessable random string stored on the
 *      row. Possession of the token is the base capability (like a presigned
 *      URL). It is created in the shares route via crypto random bytes.
 *   2. An optional PASSWORD — hashed with bcrypt and stored as `password_hash`.
 *      The plaintext never touches the database. When a visitor enters the
 *      correct password we mint a short-lived, HMAC-signed "unlock" cookie that
 *      is bound to that one token, so the password is not re-prompted on every
 *      view/download within the window and cannot be replayed for another link.
 *
 * The unlock cookie is signed with the same session secret used by the storage
 * proxy, so there is a single key to rotate. The signature covers the token and
 * the expiry, exactly mirroring lib/storage/signing.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import bcrypt from "bcryptjs"

/** How long a correct-password unlock lasts before it is re-prompted. */
export const UNLOCK_TTL_SECONDS = 60 * 30 // 30 minutes

export async function hashSharePassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifySharePassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}

function signingSecret(): string {
  return process.env.STORAGE_URL_SIGNING_SECRET || process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function computeUnlockSignature(token: string, exp: number): string {
  return b64url(createHmac("sha256", signingSecret()).update(`dms-unlock\n${token}\n${exp}`).digest())
}

/** Cookie name for a specific share token (kept short + token-scoped). */
export function unlockCookieName(token: string): string {
  return `dms_unlock_${token.slice(0, 16)}`
}

/** Mint an unlock cookie value: `<exp>.<sig>`. */
export function signUnlockCookie(token: string, ttlSeconds: number = UNLOCK_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds)
  return `${exp}.${computeUnlockSignature(token, exp)}`
}

/** Verify an unlock cookie value against the token it must be bound to. */
export function verifyUnlockCookie(token: string, value: string | undefined | null): boolean {
  if (!value) return false
  const dot = value.indexOf(".")
  if (dot <= 0) return false
  const expPart = value.slice(0, dot)
  const sigPart = value.slice(dot + 1)
  const exp = Number(expPart)
  if (!Number.isFinite(exp) || exp <= 0) return false
  if (Math.floor(Date.now() / 1000) > exp) return false
  const expected = computeUnlockSignature(token, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(sigPart)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
