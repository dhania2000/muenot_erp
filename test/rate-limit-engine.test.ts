import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __resetRateLimitEngine,
  applyEndpointOverride,
  DEFAULT_RATE_LIMIT_TIER,
  enforceRateLimit,
  PLAN_RATE_LIMITS,
  resolveTierForPlan,
  type RateLimitTier,
} from "@/lib/api-platform/rate-limit-engine"

// A generous tier whose only meaningful ceiling is the per-second burst window,
// so tests can exercise "exceed the limit" without also tripping minute/hour/day.
const burstTier: RateLimitTier = { second: 3, minute: 1_000, hour: 10_000, day: 100_000 }

describe("tiered API rate limiting", () => {
  beforeEach(() => __resetRateLimitEngine())
  afterEach(() => __resetRateLimitEngine())

  it("allows requests up to the configured limit, then blocks the next one", () => {
    const scope = "apiv1:key:1"
    // First three requests fit under the per-second ceiling of 3.
    for (let i = 0; i < 3; i++) {
      const d = enforceRateLimit(scope, burstTier)
      expect(d.allowed).toBe(true)
      expect(d.limited).toBe(false)
    }
    // The fourth exceeds it and is blocked.
    const blocked = enforceRateLimit(scope, burstTier)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limited).toBe(true)
    expect(blocked.window).toBe("second")
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  it("emits Retry-After and X-RateLimit headers when limited", () => {
    const scope = "apiv1:key:2"
    for (let i = 0; i < 3; i++) enforceRateLimit(scope, burstTier)
    const blocked = enforceRateLimit(scope, burstTier)
    expect(blocked.headers["Retry-After"]).toBeDefined()
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0)
    expect(blocked.headers["X-RateLimit-Remaining-Second"]).toBe("0")
    expect(blocked.headers["X-RateLimit-Limit-Second"]).toBe("3")
  })

  it("does not consume budget from other windows when a finer window blocks", () => {
    const scope = "apiv1:key:3"
    for (let i = 0; i < 3; i++) enforceRateLimit(scope, burstTier)
    const blocked = enforceRateLimit(scope, burstTier)
    // The blocked request must not have drained the minute budget.
    expect(blocked.headers["X-RateLimit-Remaining"]).toBe(
      String(burstTier.minute - 3),
    )
  })

  it("isolates counters per scope so one caller cannot exhaust another", () => {
    for (let i = 0; i < 3; i++) enforceRateLimit("apiv1:key:a", burstTier)
    expect(enforceRateLimit("apiv1:key:a", burstTier).allowed).toBe(false)
    // A different key starts with a full budget.
    expect(enforceRateLimit("apiv1:key:b", burstTier).allowed).toBe(true)
  })

  it("hard-blocks a caller that repeatedly violates the limit (abuse detection)", () => {
    const scope = "apiv1:key:abuse"
    // Exhaust the burst budget once.
    for (let i = 0; i < 3; i++) enforceRateLimit(scope, burstTier)
    // Keep hammering; after enough strikes the caller is hard-blocked.
    let sawAbuse = false
    for (let i = 0; i < 12; i++) {
      const d = enforceRateLimit(scope, burstTier)
      if (d.abuse) {
        sawAbuse = true
        expect(d.allowed).toBe(false)
        expect(d.retryAfter).toBeGreaterThan(0)
        break
      }
    }
    expect(sawAbuse).toBe(true)
  })

  it("resolves plan tiers and falls back safely for unknown plans", () => {
    expect(resolveTierForPlan("growth")).toEqual(PLAN_RATE_LIMITS.growth)
    expect(resolveTierForPlan("does-not-exist")).toEqual(DEFAULT_RATE_LIMIT_TIER)
    expect(resolveTierForPlan(null)).toEqual(DEFAULT_RATE_LIMIT_TIER)
    // Returned tiers are copies — mutating them must not corrupt the source.
    const t = resolveTierForPlan("growth")
    t.minute = 1
    expect(PLAN_RATE_LIMITS.growth.minute).not.toBe(1)
  })

  it("endpoint overrides can only tighten, never loosen, a plan tier", () => {
    const base: RateLimitTier = { second: 20, minute: 300, hour: 10_000, day: 150_000 }
    const tightened = applyEndpointOverride(base, { second: 5 })
    expect(tightened.second).toBe(5)
    // An override larger than the plan value is ignored (stays at the plan ceiling).
    const loosened = applyEndpointOverride(base, { second: 999 })
    expect(loosened.second).toBe(20)
  })
})
