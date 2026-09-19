import "server-only"

/**
 * Lightweight in-memory rate limiter for pre-auth endpoints (login, signup).
 *
 * Backed by a process-global Map so it survives Next.js hot-reloads and is
 * shared across requests in a single server instance. This is intentionally
 * simple brute-force protection — not a distributed limiter. For a multi-node
 * deployment, back this with Redis, but for a single Hostinger/Node instance
 * (this app's target) an in-memory fixed window is effective and dependency-free.
 */

type Bucket = {
  count: number
  resetAt: number
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBuckets: Map<string, Bucket> | undefined
}

const buckets = globalThis.__rateLimitBuckets ?? new Map<string, Bucket>()
if (!globalThis.__rateLimitBuckets) globalThis.__rateLimitBuckets = buckets

export type RateLimitResult = {
  allowed: boolean
  /** Seconds until the window resets (only meaningful when !allowed). */
  retryAfter: number
  remaining: number
}

/**
 * Fixed-window rate limit. Returns whether the call is allowed and, when
 * blocked, how many seconds until the window resets.
 */
export function checkRateLimit(
  key: string,
  options: { max: number; windowMs: number },
): RateLimitResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs })
    return { allowed: true, retryAfter: 0, remaining: options.max - 1 }
  }

  if (existing.count >= options.max) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      remaining: 0,
    }
  }

  existing.count += 1
  return { allowed: true, retryAfter: 0, remaining: options.max - existing.count }
}

/** Clear a key's counter — call after a successful login so a good password resets the window. */
export function resetRateLimit(key: string): void {
  buckets.delete(key)
}

/** Best-effort client IP from common proxy headers, falling back to a constant. */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")?.trim() || "unknown"
}
