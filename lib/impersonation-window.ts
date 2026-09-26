/**
 * Dependency-free impersonation window rules (Spec47). Kept separate from
 * lib/audit-streams-model.ts so lib/auth.ts (also loaded by the proxy) does not
 * pull in node:crypto.
 */
export const IMPERSONATION_LIMITS = { DEFAULT_MINUTES: 30, MIN_MINUTES: 5, MAX_MINUTES: 120, MIN_REASON: 10, MAX_REASON: 500 } as const

export function resolveImpersonationMinutes(input: unknown): number {
  const n = Number(input)
  if (input == null || input === "" || !Number.isFinite(n)) return IMPERSONATION_LIMITS.DEFAULT_MINUTES
  return Math.min(Math.max(Math.round(n), IMPERSONATION_LIMITS.MIN_MINUTES), IMPERSONATION_LIMITS.MAX_MINUTES)
}

export function computeImpersonationExpiry(nowMs: number, minutes: number): number {
  return nowMs + resolveImpersonationMinutes(minutes) * 60_000
}

/**
 * An impersonation is honored only while its signed expiry is in the future.
 * A missing expiry (legacy/forged token) fails CLOSED.
 */
export function isImpersonationWindowOpen(expiresAtMs: unknown, nowMs: number): boolean {
  return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
}

export function validateImpersonationReason(reason: unknown): string | null {
  const r = typeof reason === "string" ? reason.trim() : ""
  if (r.length < IMPERSONATION_LIMITS.MIN_REASON || r.length > IMPERSONATION_LIMITS.MAX_REASON) return null
  return r
}
