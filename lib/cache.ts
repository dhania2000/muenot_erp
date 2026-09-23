import "server-only"

/**
 * Scalability: a small, dependency-free in-process caching layer.
 * ---------------------------------------------------------------------------
 * Read-heavy hot paths (plan-tier lookups, config resolution, reference data)
 * repeatedly hit MySQL for values that change rarely. Before this module every
 * such cache was an ad-hoc `Map` with no TTL, no size bound (a slow memory
 * leak under many tenants), and no visibility into hit/miss behavior.
 *
 * `TtlCache` gives every caller the same bounded, observable primitive:
 *   - TTL expiry            — stale entries are never served.
 *   - LRU eviction          — a hard `maxEntries` cap bounds per-node memory,
 *                             so cache size can't grow with tenant/user count.
 *   - single-flight loads   — concurrent misses for the same key share ONE
 *                             loader call (`getOrLoad`), so a cold cache under
 *                             load does not stampede the database.
 *   - metrics               — hit/miss/eviction counters, aggregated across the
 *                             registry for the capacity/observability surface.
 *
 * SCOPE: this is a PER-NODE cache, which is correct for the platform's
 * stateless, horizontally-scaled model — every node keeps its own bounded copy
 * of rarely-changing read data. It is NOT a coordination primitive: anything
 * that must be consistent across nodes (rate-limit counters, job claims,
 * sessions) already lives in shared MySQL and must stay there. Only cache data
 * that is safe to serve slightly stale for the chosen TTL, and give
 * tenant-scoped values tenant-scoped keys so one tenant can never read
 * another's cached row.
 */

export type CacheStats = {
  hits: number
  misses: number
  sets: number
  evictions: number
  expirations: number
  /** Live entry count at the moment the snapshot was taken. */
  size: number
  maxEntries: number
}

export type TtlCacheOptions = {
  /** Hard cap on live entries; least-recently-used entries are evicted past it. */
  maxEntries?: number
  /** Default TTL (ms) applied when `set`/`getOrLoad` omit one. */
  defaultTtlMs?: number
}

type Entry<V> = { value: V; expiresAt: number }

const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_TTL_MS = 60_000

export class TtlCache<V = unknown> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly inflight = new Map<string, Promise<V>>()
  private readonly maxEntries: number
  private readonly defaultTtlMs: number
  private hits = 0
  private misses = 0
  private sets = 0
  private evictions = 0
  private expirations = 0

  constructor(
    /** Stable label used in aggregated metrics; also the registry key. */
    readonly namespace: string,
    options: TtlCacheOptions = {},
  ) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
    this.defaultTtlMs = Math.max(1, Math.trunc(options.defaultTtlMs ?? DEFAULT_TTL_MS))
  }

  /** Return the live value for `key`, or `undefined` on a miss / expiry. */
  get(key: string): V | undefined {
    const entry = this.store.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      this.expirations++
      this.misses++
      return undefined
    }
    // Mark most-recently-used by reinserting (Map preserves insertion order).
    this.store.delete(key)
    this.store.set(key, entry)
    this.hits++
    return entry.value
  }

  /** Store `value` under `key` for `ttlMs` (defaults to the cache's TTL). */
  set(key: string, value: V, ttlMs?: number): void {
    const ttl = Math.max(1, Math.trunc(ttlMs ?? this.defaultTtlMs))
    // Reinsert so the freshest write is treated as most-recently-used.
    this.store.delete(key)
    this.store.set(key, { value, expiresAt: Date.now() + ttl })
    this.sets++
    this.evictOverflow()
  }

  /**
   * Return the cached value, or run `loader` to populate it. Concurrent misses
   * for the same key share a single in-flight loader call (single-flight), so a
   * cold key under load results in exactly one backend fetch. A rejected load
   * is never cached and is re-attempted on the next call.
   */
  async getOrLoad(key: string, loader: () => Promise<V>, ttlMs?: number): Promise<V> {
    const cached = this.get(key)
    if (cached !== undefined) return cached

    const pending = this.inflight.get(key)
    if (pending) return pending

    const promise = (async () => {
      try {
        const value = await loader()
        this.set(key, value, ttlMs)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, promise)
    return promise
  }

  /** Drop a single key (e.g. after a write invalidates it). */
  delete(key: string): void {
    this.store.delete(key)
  }

  /**
   * Drop every entry whose key starts with `prefix`, returning the count
   * removed. This is what makes group invalidation possible: the tenant-safe
   * cache layer (lib/tenant-cache.ts) prefixes every key with `t:<tenantId>:`,
   * so evicting one tenant's entire footprint is a single prefix sweep — the
   * mechanism that keeps a stale entry from ever outliving a tenant write.
   */
  deleteByPrefix(prefix: string): number {
    if (prefix === "") {
      const removed = this.store.size
      this.store.clear()
      return removed
    }
    let removed = 0
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
        removed++
      }
    }
    return removed
  }

  /** Snapshot of the live keys (order = LRU, oldest first). For diagnostics/tests. */
  keys(): string[] {
    return [...this.store.keys()]
  }

  /** Drop every entry; counters are preserved for lifetime metrics. */
  clear(): void {
    this.store.clear()
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.store.size,
      maxEntries: this.maxEntries,
    }
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
      this.evictions++
    }
  }
}

// ---------------------------------------------------------------------------
// Registry — lets the observability surface report every cache in one place.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __ttlCacheRegistry: Map<string, TtlCache<any>> | undefined
}

const registry = globalThis.__ttlCacheRegistry ?? new Map<string, TtlCache<any>>()
if (!globalThis.__ttlCacheRegistry) globalThis.__ttlCacheRegistry = registry

/**
 * Create (or reuse) a named cache. Reusing by namespace keeps the cache stable
 * across Next.js hot-reloads and module re-evaluation, and registers it for
 * aggregated metrics.
 */
export function createCache<V = unknown>(namespace: string, options?: TtlCacheOptions): TtlCache<V> {
  const existing = registry.get(namespace)
  if (existing) return existing as TtlCache<V>
  const cache = new TtlCache<V>(namespace, options)
  registry.set(namespace, cache)
  return cache
}

/** Point-in-time metrics for every registered cache — for capacity dashboards. */
export function cacheRegistrySnapshot(): Array<{ namespace: string } & CacheStats> {
  return [...registry.entries()].map(([namespace, cache]) => ({ namespace, ...cache.stats() }))
}
