import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TtlCache, createCache, cacheRegistrySnapshot } from "@/lib/cache"

/**
 * SPEC 78 — unit coverage for the shared in-process cache: TTL expiry, LRU
 * eviction bound, single-flight coalescing, invalidation, and metrics.
 */
describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns undefined on a miss and the value on a hit", () => {
    const cache = new TtlCache<number>("t")
    expect(cache.get("a")).toBeUndefined()
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
  })

  it("expires entries after their TTL", () => {
    const cache = new TtlCache<number>("t", { defaultTtlMs: 1000 })
    cache.set("a", 1)
    vi.advanceTimersByTime(999)
    expect(cache.get("a")).toBe(1)
    vi.advanceTimersByTime(2)
    expect(cache.get("a")).toBeUndefined()
  })

  it("evicts least-recently-used entries past maxEntries", () => {
    const cache = new TtlCache<number>("t", { maxEntries: 2 })
    cache.set("a", 1)
    cache.set("b", 2)
    // Touch "a" so "b" becomes the LRU victim.
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("c")).toBe(3)
    expect(cache.stats().evictions).toBe(1)
  })

  it("single-flights concurrent misses into one loader call", async () => {
    const cache = new TtlCache<string>("t")
    let calls = 0
    const loader = () => {
      calls++
      return new Promise<string>((resolve) => setTimeout(() => resolve("v"), 10))
    }
    const all = Promise.all([
      cache.getOrLoad("k", loader),
      cache.getOrLoad("k", loader),
      cache.getOrLoad("k", loader),
    ])
    await vi.advanceTimersByTimeAsync(10)
    expect(await all).toEqual(["v", "v", "v"])
    expect(calls).toBe(1)
  })

  it("does not cache a rejected load and retries next call", async () => {
    const cache = new TtlCache<string>("t")
    let calls = 0
    const loader = () => {
      calls++
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok")
    }
    await expect(cache.getOrLoad("k", loader)).rejects.toThrow("boom")
    await expect(cache.getOrLoad("k", loader)).resolves.toBe("ok")
    expect(calls).toBe(2)
  })

  it("invalidates a single key on delete", () => {
    const cache = new TtlCache<number>("t")
    cache.set("a", 1)
    cache.delete("a")
    expect(cache.get("a")).toBeUndefined()
  })

  it("deleteByPrefix drops only the matching keys and reports the count", () => {
    const cache = new TtlCache<number>("t")
    cache.set("t:1:a", 1)
    cache.set("t:1:b", 2)
    cache.set("t:2:a", 3)
    const removed = cache.deleteByPrefix("t:1:")
    expect(removed).toBe(2)
    expect(cache.get("t:1:a")).toBeUndefined()
    expect(cache.get("t:1:b")).toBeUndefined()
    expect(cache.get("t:2:a")).toBe(3)
  })

  it("deleteByPrefix with an empty prefix clears everything", () => {
    const cache = new TtlCache<number>("t")
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.deleteByPrefix("")).toBe(2)
    expect(cache.keys()).toEqual([])
  })

  it("tracks hit/miss metrics", () => {
    const cache = new TtlCache<number>("t")
    cache.get("a") // miss
    cache.set("a", 1)
    cache.get("a") // hit
    const stats = cache.stats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.sets).toBe(1)
    expect(stats.size).toBe(1)
  })
})

describe("cache registry", () => {
  it("reuses a cache by namespace and exposes it in the snapshot", () => {
    const a = createCache<number>("registry-test-ns")
    const b = createCache<number>("registry-test-ns")
    expect(a).toBe(b)
    const snapshot = cacheRegistrySnapshot()
    expect(snapshot.some((entry) => entry.namespace === "registry-test-ns")).toBe(true)
  })
})
