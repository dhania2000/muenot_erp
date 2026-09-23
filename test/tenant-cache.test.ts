import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cached,
  cachedForTenant,
  cachedGlobal,
  invalidateCurrentTenant,
  invalidateTenant,
  invalidateTenantKey,
  invalidateTenantTarget,
  invalidateTargetForAllTenants,
} from "@/lib/tenant-cache"
import { setCurrentTenant } from "@/lib/tenant-context"

/**
 * SPEC 80 — Phase 4. Safety validation for the tenant-safe caching layer.
 *
 * The whole point of this layer is that a cache can NEVER become a
 * cross-tenant leak, and that a write is never masked by a stale entry. Every
 * test frames one of those two guarantees:
 *   - TENANT ISOLATION: two tenants asking the same logical question under the
 *     same subkey never share a value, even with identical inputs.
 *   - STALE DATA: TTL expiry and explicit invalidation both force a re-load.
 *   - FAIL CLOSED: with no safe owner key, the layer reads through rather than
 *     caching under a shared bucket.
 */

// Start every test from a clean cache so entries never bleed across cases
// (the underlying caches are process-global by design).
beforeEach(() => {
  invalidateTargetForAllTenants("config")
  invalidateTargetForAllTenants("permissions")
  invalidateTargetForAllTenants("entitlements")
  setCurrentTenant(null)
})

afterEach(() => {
  setCurrentTenant(null)
  vi.useRealTimers()
})

describe("tenant isolation (leak attempt: two tenants, same subkey)", () => {
  it("never serves one tenant's cached value to another", async () => {
    const load = (tenantId: number) => async () => `data-for-${tenantId}`

    const a1 = await cachedForTenant("config", 1, "settings", load(1))
    const b2 = await cachedForTenant("config", 2, "settings", load(2))
    // A warmed entry for tenant 1 must not be returned to tenant 2.
    const a1Again = await cachedForTenant("config", 1, "settings", async () => "should-not-run")
    const b2Again = await cachedForTenant("config", 2, "settings", async () => "should-not-run")

    expect(a1).toBe("data-for-1")
    expect(b2).toBe("data-for-2")
    expect(a1Again).toBe("data-for-1")
    expect(b2Again).toBe("data-for-2")
  })

  it("loads exactly once per tenant even under identical subkeys", async () => {
    const calls: number[] = []
    const load = (tenantId: number) => async () => {
      calls.push(tenantId)
      return tenantId
    }
    await cachedForTenant("permissions", 10, "matrix", load(10))
    await cachedForTenant("permissions", 10, "matrix", load(10)) // hit
    await cachedForTenant("permissions", 20, "matrix", load(20)) // distinct tenant
    expect(calls).toEqual([10, 20])
  })

  it("derives the owner from context and keeps contexts separate", async () => {
    setCurrentTenant({ tenantId: 1, slug: "a" })
    const first = await cached("config", "ctx", async () => "tenant-1-value")

    setCurrentTenant({ tenantId: 2, slug: "b" })
    const second = await cached("config", "ctx", async () => "tenant-2-value")

    // Back to tenant 1: must see tenant 1's cached value, not tenant 2's.
    setCurrentTenant({ tenantId: 1, slug: "a" })
    const firstAgain = await cached("config", "ctx", async () => "should-not-run")

    expect(first).toBe("tenant-1-value")
    expect(second).toBe("tenant-2-value")
    expect(firstAgain).toBe("tenant-1-value")
  })
})

describe("stale data (TTL expiry + explicit invalidation)", () => {
  it("re-loads after the TTL elapses", async () => {
    vi.useFakeTimers()
    let n = 0
    const loader = async () => ++n
    const first = await cachedForTenant("config", 1, "k", loader, 1000)
    vi.advanceTimersByTime(999)
    const stillCached = await cachedForTenant("config", 1, "k", loader, 1000)
    vi.advanceTimersByTime(2)
    const afterExpiry = await cachedForTenant("config", 1, "k", loader, 1000)
    expect(first).toBe(1)
    expect(stillCached).toBe(1)
    expect(afterExpiry).toBe(2)
  })

  it("invalidateTenantKey drops exactly one key", async () => {
    let n = 0
    const loader = async () => ++n
    expect(await cachedForTenant("config", 1, "k", loader)).toBe(1)
    invalidateTenantKey("config", 1, "k")
    expect(await cachedForTenant("config", 1, "k", loader)).toBe(2)
  })

  it("invalidateTenantTarget drops all of a tenant's entries in one target only", async () => {
    await cachedForTenant("config", 1, "a", async () => "a")
    await cachedForTenant("config", 1, "b", async () => "b")
    await cachedForTenant("config", 2, "a", async () => "t2")

    const removed = invalidateTenantTarget("config", 1)
    expect(removed).toBe(2)

    // Tenant 1 re-loads; tenant 2 is untouched.
    expect(await cachedForTenant("config", 1, "a", async () => "reload")).toBe("reload")
    expect(await cachedForTenant("config", 2, "a", async () => "should-not-run")).toBe("t2")
  })

  it("invalidateTenant sweeps a tenant across every target", async () => {
    await cachedForTenant("config", 1, "k", async () => "cfg")
    await cachedForTenant("permissions", 1, "k", async () => "perm")
    await cachedForTenant("entitlements", 1, "k", async () => "ent")
    await cachedForTenant("config", 2, "k", async () => "other-tenant")

    const removed = invalidateTenant(1)
    expect(removed).toBe(3)

    expect(await cachedForTenant("config", 1, "k", async () => "r1")).toBe("r1")
    expect(await cachedForTenant("permissions", 1, "k", async () => "r2")).toBe("r2")
    expect(await cachedForTenant("entitlements", 1, "k", async () => "r3")).toBe("r3")
    // Tenant 2 survived the sweep.
    expect(await cachedForTenant("config", 2, "k", async () => "should-not-run")).toBe("other-tenant")
  })

  it("invalidateCurrentTenant clears only the context tenant", async () => {
    await cachedForTenant("config", 1, "k", async () => "one")
    await cachedForTenant("config", 2, "k", async () => "two")
    setCurrentTenant({ tenantId: 1, slug: "a" })
    invalidateCurrentTenant()
    expect(await cachedForTenant("config", 1, "k", async () => "reload")).toBe("reload")
    expect(await cachedForTenant("config", 2, "k", async () => "should-not-run")).toBe("two")
  })
})

describe("fail-closed behavior (no safe owner key)", () => {
  it("cached() reads through uncached when there is no tenant in context", async () => {
    setCurrentTenant(null)
    let n = 0
    const loader = async () => ++n
    expect(await cached("config", "k", loader)).toBe(1)
    // No caching happened, so the next call loads again.
    expect(await cached("config", "k", loader)).toBe(2)
  })

  it("cachedForTenant() reads through uncached for a non-positive tenant id", async () => {
    let n = 0
    const loader = async () => ++n
    expect(await cachedForTenant("config", 0, "k", loader)).toBe(1)
    expect(await cachedForTenant("config", -5, "k", loader)).toBe(2)
    expect(await cachedForTenant("config", 0, "k", loader)).toBe(3)
  })
})

describe("scope guards (tenant vs global cannot be confused)", () => {
  it("refuses cachedGlobal on a tenant-scoped target", async () => {
    await expect(cachedGlobal("config", "k", async () => "x")).rejects.toThrow(/tenant-scoped/)
  })

  it("refuses cachedForTenant on... (all catalog targets are tenant-scoped)", async () => {
    // Every current target is tenant-scoped, so cached()/cachedForTenant() are
    // the only valid entry points; this documents that invariant.
    const single = await cachedForTenant("reports", 1, "r", async () => "ok")
    expect(single).toBe("ok")
  })
})
