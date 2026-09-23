import "server-only"

/**
 * High availability: shared, distributed pre-auth rate limiter.
 *
 * Pre-auth endpoints (signup, mobile login/refresh, public app-version and
 * shopkeeper registration) need brute-force protection BEFORE a tenant/session
 * exists, so they cannot use the tenant-scoped API limiter
 * (lib/api-platform/rate-limit-store.ts, which requires a tenant id + FK).
 *
 * Previously this module kept counters in a process-global Map. That is
 * "local-only state": with more than one application server behind a load
 * balancer, each node enforced the window independently (an attacker got
 * `max` attempts PER node), and every counter was lost on restart/redeploy —
 * a classic single-point-of-failure / non-horizontally-scalable design.
 *
 * It is now backed by a shared MySQL table so the window is enforced
 * consistently across every node and survives restarts. The in-memory map is
 * retained ONLY as a fail-open fallback: if the database is briefly
 * unreachable the limiter degrades to per-node protection rather than
 * throwing, so a DB blip never takes down the login/signup path (availability
 * first, matching the platform's session-store degradation posture).
 *
 * The table self-heals at runtime (same pattern as lib/session-store.ts), so
 * existing databases converge without a manual migration step.
 */

import { createHash } from "node:crypto"
import { pool, query } from "@/lib/db"

export type RateLimitResult = {
  allowed: boolean
  /** Seconds until the window resets (only meaningful when !allowed). */
  retryAfter: number
  remaining: number
}

type RateLimitOptions = { max: number; windowMs: number }

// ---------------------------------------------------------------------------
// Shared (distributed) store
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

function runEnsure(): Promise<void> {
  return query(`CREATE TABLE IF NOT EXISTS platform_pre_auth_rate_limits (
    bucket_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    window_reset_ms BIGINT UNSIGNED NOT NULL,
    request_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (bucket_key),
    KEY idx_pre_auth_rate_expiry (window_reset_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => undefined)
}

/** Idempotent, cached schema bootstrap. Exposed for tests. */
export function ensurePreAuthRateLimitSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/**
 * Atomically read + advance one fixed-window counter under a row lock so that
 * concurrent requests across all nodes see a single serialized decision. A
 * blocked request does not consume additional budget beyond recording the
 * strike (the count is already at/over the ceiling).
 */
async function sharedCheck(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  await ensurePreAuthRateLimitSchema()
  const hash = digest(key)
  const now = Date.now()
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `INSERT INTO platform_pre_auth_rate_limits (bucket_key, window_reset_ms, request_count)
       VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE bucket_key = bucket_key`,
      [hash, now + options.windowMs],
    )
    const [rows] = await connection.query<any[]>(
      `SELECT window_reset_ms, request_count FROM platform_pre_auth_rate_limits
        WHERE bucket_key = ? FOR UPDATE`,
      [hash],
    )
    const row = rows[0]
    let resetAt = Number(row?.window_reset_ms ?? now + options.windowMs)
    let count = Number(row?.request_count ?? 0)
    // Expired window: start a fresh one.
    if (resetAt <= now) {
      resetAt = now + options.windowMs
      count = 0
    }
    if (count >= options.max) {
      // Persist the (possibly rolled) window without consuming more budget.
      await connection.query(
        `UPDATE platform_pre_auth_rate_limits SET window_reset_ms = ?, request_count = ? WHERE bucket_key = ?`,
        [resetAt, count, hash],
      )
      await connection.commit()
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)), remaining: 0 }
    }
    count += 1
    await connection.query(
      `UPDATE platform_pre_auth_rate_limits SET window_reset_ms = ?, request_count = ? WHERE bucket_key = ?`,
      [resetAt, count, hash],
    )
    await connection.commit()
    return { allowed: true, retryAfter: 0, remaining: options.max - count }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (per-node, used only when the shared store is unreachable)
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number }

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBuckets: Map<string, Bucket> | undefined
}

const localBuckets = globalThis.__rateLimitBuckets ?? new Map<string, Bucket>()
if (!globalThis.__rateLimitBuckets) globalThis.__rateLimitBuckets = localBuckets

function localCheck(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const existing = localBuckets.get(key)
  if (!existing || existing.resetAt <= now) {
    localBuckets.set(key, { count: 1, resetAt: now + options.windowMs })
    return { allowed: true, retryAfter: 0, remaining: options.max - 1 }
  }
  if (existing.count >= options.max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)), remaining: 0 }
  }
  existing.count += 1
  return { allowed: true, retryAfter: 0, remaining: options.max - existing.count }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Distributed fixed-window rate limit. Returns whether the call is allowed and,
 * when blocked, how many seconds until the window resets. Never throws: a
 * shared-store outage falls back to per-node in-memory protection so the
 * pre-auth path stays available.
 */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  try {
    return await sharedCheck(key, options)
  } catch (error) {
    console.error("[v0] shared rate limiter unavailable, falling back to in-memory", error)
    return localCheck(key, options)
  }
}

/** Clear a key's counter — call after a successful login so a good password resets the window. */
export async function resetRateLimit(key: string): Promise<void> {
  localBuckets.delete(key)
  try {
    await ensurePreAuthRateLimitSchema()
    await query("DELETE FROM platform_pre_auth_rate_limits WHERE bucket_key = ?", [digest(key)])
  } catch (error) {
    console.error("[v0] rate limiter reset failed", error)
  }
}

/**
 * Remove expired counters. Call from the existing rate-limit cleanup scheduler.
 * No user data is removed; returns the number of pruned rows.
 */
export async function prunePreAuthRateLimits(): Promise<number> {
  await ensurePreAuthRateLimitSchema()
  const result = await query<{ affectedRows?: number }>(
    "DELETE FROM platform_pre_auth_rate_limits WHERE window_reset_ms < ?",
    [Date.now()],
  )
  return Number(result?.affectedRows ?? 0)
}

/** Best-effort client IP from common proxy headers, falling back to a constant. */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")?.trim() || "unknown"
}
