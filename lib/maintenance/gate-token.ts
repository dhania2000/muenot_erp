/**
 * Spec28 (#125) — Shared secret between the request gate (middleware) and the
 * internal live-window feed. Derived from SESSION_SECRET with a fixed domain
 * label, so it is never the session key itself. Web Crypto only: runs on both
 * the edge and Node runtimes and yields identical output.
 */
const LABEL = "muenot:maintenance-gate:v1"
export const GATE_HEADER = "x-maintenance-gate"

export async function maintenanceGateToken(secret: string | undefined): Promise<string | null> {
  return derivedGateToken(secret, LABEL)
}

/**
 * Spec46 — separate domain label for the billing write-lock feed, so a leaked
 * maintenance token cannot read tenant subscription state (and vice versa).
 */
const BILLING_WRITE_LOCK_LABEL = "muenot:billing-write-lock:v1"
export const BILLING_GATE_HEADER = "x-billing-gate"

export async function billingWriteLockToken(secret: string | undefined): Promise<string | null> {
  return derivedGateToken(secret, BILLING_WRITE_LOCK_LABEL)
}

async function derivedGateToken(secret: string | undefined, label: string): Promise<string | null> {
  if (!secret) return null
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(label)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
