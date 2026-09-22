import "server-only"
/**
 * SPEC 53 — Tiered API rate limiting for the public `/api/v1/*` surface.
 * ---------------------------------------------------------------------------
 * The simple single-window limiter in lib/rate-limit.ts is not enough for a
 * multi-tenant API: different plans buy different throughput, some endpoints
 * are more expensive than others, and a single client should not be able to
 * empty a whole minute's budget in one burst. This engine layers four fixed
 * windows on top of each other:
 *
 *   - `second` — burst control (smooths out spikes),
 *   - `minute` / `hour` / `day` — sustained-throughput ceilings.
 *
 * A request is allowed only when it fits under EVERY window; the first window
 * it would breach becomes the "offending" window and drives `Retry-After`.
 * Limits are resolved from the tenant's plan (see PLAN_RATE_LIMITS) and can be
 * narrowed per-endpoint (an expensive route can pin a lower ceiling).
 *
 * Repeatedly hammering a limit trips abuse detection: after enough violations
 * inside a short window the caller is temporarily hard-blocked, independent of
 * the rolling counters, so a misbehaving integration backs all the way off.
 *
 * Counters live in-process (same trade-off as lib/rate-limit.ts) — correct and
 * fast per instance, and the natural seam to swap for Redis later.
 */

export type RateWindowKey = "second" | "minute" | "hour" | "day"

export type RateLimitTier = Record<RateWindowKey, number>

const WINDOW_ORDER: RateWindowKey[] = ["second", "minute", "hour", "day"]

const WINDOW_MS: Record<RateWindowKey, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

/**
 * Per-plan throughput. Plans map to the `tenants.plan` column
 * (see lib/tenant-onboarding.ts PLANS). Unknown/internal plans fall back to
 * DEFAULT_RATE_LIMIT_TIER.
 */
export const PLAN_RATE_LIMITS: Record<string, RateLimitTier> = {
  starter: { second: 5, minute: 60, hour: 1_000, day: 10_000 },
  growth: { second: 20, minute: 300, hour: 10_000, day: 150_000 },
  enterprise: { second: 60, minute: 1_200, hour: 60_000, day: 1_000_000 },
}

export const DEFAULT_RATE_LIMIT_TIER: RateLimitTier = PLAN_RATE_LIMITS.starter

/** Resolve the base tier for a tenant's plan string, defaulting safely. */
export function resolveTierForPlan(plan: string | null | undefined): RateLimitTier {
  if (plan && PLAN_RATE_LIMITS[plan]) return { ...PLAN_RATE_LIMITS[plan] }
  return { ...DEFAULT_RATE_LIMIT_TIER }
}

/**
 * Narrow a plan tier with an endpoint-specific override. Each provided window
 * caps at the smaller of the plan value and the override, so an expensive
 * endpoint can only ever be stricter than the plan — never looser.
 */
export function applyEndpointOverride(
  tier: RateLimitTier,
  override?: Partial<RateLimitTier>,
): RateLimitTier {
  if (!override) return tier
  const next: RateLimitTier = { ...tier }
  for (const w of WINDOW_ORDER) {
    const o = override[w]
    if (typeof o === "number" && o >= 0) next[w] = Math.min(next[w], o)
  }
  return next
}

// ── Abuse-detection tuning ───────────────────────────────────────────────────

/** Rolling window over which rate-limit violations accumulate into strikes. */
const ABUSE_WINDOW_MS = 60_000
/** Violations within ABUSE_WINDOW_MS that trip a temporary hard block. */
const ABUSE_STRIKE_THRESHOLD = 10
/** How long a tripped caller stays hard-blocked. */
const ABUSE_BLOCK_MS = 5 * 60_000

// ── In-process state ─────────────────────────────────────────────────────────

type Bucket = { count: number; resetAt: number }
type AbuseState = { strikes: number; windowResetAt: number; blockedUntil: number }

const buckets = new Map<string, Bucket>()
const abuse = new Map<string, AbuseState>()

/** Reset that aligns to fixed calendar-style boundaries so resets are stable. */
function alignedReset(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs + windowMs
}

function getBucket(scope: string, w: RateWindowKey, now: number): Bucket {
  const key = `${scope}:${w}`
  let b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: alignedReset(now, WINDOW_MS[w]) }
    buckets.set(key, b)
  }
  return b
}

function registerStrike(scope: string, now: number): boolean {
  let s = abuse.get(scope)
  if (!s || s.windowResetAt <= now) {
    s = { strikes: 0, windowResetAt: now + ABUSE_WINDOW_MS, blockedUntil: s?.blockedUntil ?? 0 }
  }
  s.strikes += 1
  let tripped = false
  if (s.strikes >= ABUSE_STRIKE_THRESHOLD) {
    s.blockedUntil = now + ABUSE_BLOCK_MS
    s.strikes = 0
    s.windowResetAt = now + ABUSE_WINDOW_MS
    tripped = true
  }
  abuse.set(scope, s)
  return tripped
}

export type RateLimitDecision = {
  /** Whether the request may proceed. */
  allowed: boolean
  /** Blocked by a rolling window ceiling. */
  limited: boolean
  /** Blocked by abuse detection (temporary hard block). */
  abuse: boolean
  /** The window that caused a block, if any. */
  window: RateWindowKey | null
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfter: number
  /** Ready-to-attach response headers (X-RateLimit-*, Retry-After when blocked). */
  headers: Record<string, string>
}

function buildHeaders(
  scope: string,
  tier: RateLimitTier,
  now: number,
  retryAfter: number,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const w of WINDOW_ORDER) {
    const b = getBucket(scope, w, now)
    const remaining = Math.max(0, tier[w] - b.count)
    const suffix = w.charAt(0).toUpperCase() + w.slice(1)
    headers[`X-RateLimit-Limit-${suffix}`] = String(tier[w])
    headers[`X-RateLimit-Remaining-${suffix}`] = String(remaining)
  }
  // Primary (unsuffixed) headers track the minute window — the conventional default.
  const minute = getBucket(scope, "minute", now)
  headers["X-RateLimit-Limit"] = String(tier.minute)
  headers["X-RateLimit-Remaining"] = String(Math.max(0, tier.minute - minute.count))
  headers["X-RateLimit-Reset"] = String(Math.ceil(minute.resetAt / 1000))
  if (retryAfter > 0) headers["Retry-After"] = String(retryAfter)
  return headers
}

/**
 * Check (and, when allowed, consume) one request's worth of budget for `scope`
 * against `tier`. Pure counting logic with no I/O — safe to call on the hot
 * path. `scope` should uniquely identify the caller (e.g. `apiv1:key:42`).
 */
export function enforceRateLimit(scope: string, tier: RateLimitTier): RateLimitDecision {
  const now = Date.now()

  // 1. Hard block from a prior abuse trip.
  const abuseState = abuse.get(scope)
  if (abuseState && abuseState.blockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((abuseState.blockedUntil - now) / 1000))
    return {
      allowed: false,
      limited: false,
      abuse: true,
      window: null,
      retryAfter,
      headers: { ...buildHeaders(scope, tier, now, retryAfter) },
    }
  }

  // 2. Peek every window; the first breach (finest → coarsest) is the offender.
  let offending: RateWindowKey | null = null
  for (const w of WINDOW_ORDER) {
    const b = getBucket(scope, w, now)
    if (b.count >= tier[w]) {
      offending = w
      break
    }
  }

  if (offending) {
    const tripped = registerStrike(scope, now)
    const b = getBucket(scope, offending, now)
    const windowRetry = Math.max(1, Math.ceil((b.resetAt - now) / 1000))
    const retryAfter = tripped ? Math.ceil(ABUSE_BLOCK_MS / 1000) : windowRetry
    return {
      allowed: false,
      limited: true,
      abuse: tripped,
      window: offending,
      retryAfter,
      headers: buildHeaders(scope, tier, now, retryAfter),
    }
  }

  // 3. Fits everywhere — consume one unit from each window.
  for (const w of WINDOW_ORDER) getBucket(scope, w, now).count += 1

  return {
    allowed: true,
    limited: false,
    abuse: false,
    window: null,
    retryAfter: 0,
    headers: buildHeaders(scope, tier, now, 0),
  }
}

export type RateWindowSnapshot = {
  window: RateWindowKey
  count: number
  resetAt: number
}

export type RateLimitScopeSnapshot = {
  scope: string
  windows: RateWindowSnapshot[]
  blockedUntil: number | null
}

/**
 * Read the live, in-process state of every active scope without consuming
 * budget. Powers the SPEC 53 monitoring UI: real current usage per window and
 * any active abuse hard-block. Expired buckets are skipped so callers only see
 * counters that are still meaningful.
 */
export function snapshotRateLimits(): RateLimitScopeSnapshot[] {
  const now = Date.now()
  const byScope = new Map<string, RateLimitScopeSnapshot>()

  const ensure = (scope: string): RateLimitScopeSnapshot => {
    let snap = byScope.get(scope)
    if (!snap) {
      snap = { scope, windows: [], blockedUntil: null }
      byScope.set(scope, snap)
    }
    return snap
  }

  for (const [key, b] of buckets.entries()) {
    if (b.resetAt <= now || b.count === 0) continue
    const idx = key.lastIndexOf(":")
    if (idx < 0) continue
    const scope = key.slice(0, idx)
    const w = key.slice(idx + 1) as RateWindowKey
    if (!WINDOW_MS[w]) continue
    ensure(scope).windows.push({ window: w, count: b.count, resetAt: b.resetAt })
  }

  for (const [scope, s] of abuse.entries()) {
    if (s.blockedUntil > now) ensure(scope).blockedUntil = s.blockedUntil
  }

  for (const snap of byScope.values()) {
    snap.windows.sort((a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window))
  }

  return Array.from(byScope.values())
}

/** Test-only: wipe all in-process counters and abuse state. */
export function __resetRateLimitEngine(): void {
  buckets.clear()
  abuse.clear()
}
