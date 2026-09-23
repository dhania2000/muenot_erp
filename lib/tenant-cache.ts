import "server-only"

/**
 * SPEC 80 — Safe caching architecture.
 * ---------------------------------------------------------------------------
 * SPEC 78 gave us a bounded, observable per-node primitive (`TtlCache` in
 * lib/cache.ts). But a raw cache is a LEAK WAITING TO HAPPEN in a multi-tenant
 * system with no row-level security (SPEC 2): the moment a caller forgets to
 * put the tenant id in the key, tenant A can be served tenant B's cached rows.
 *
 * This module is the safety layer that makes that mistake structurally
 * impossible for the platform's cacheable read paths. It does three things:
 *
 *   Phase 1 — CANDIDATES. `CACHE_TARGETS` is the reviewed inventory of what is
 *             safe to cache and for how long: configuration, permissions,
 *             feature entitlements, master data, dashboard metrics, and
 *             frequently-accessed reports. Every target is tenant-scoped unless
 *             explicitly marked global, because tenant-scoped is the safe
 *             default.
 *
 *   Phase 2 — ABSTRACTION. Callers never build a cache key by hand. They call
 *             `cachedForTenant(target, tenantId, subkey, loader)` (or the
 *             context-driven `cached(...)`), and the OWNER tenant id is folded
 *             into the key as a mandatory `t:<tenantId>:` prefix. There is no
 *             API to store a tenant value under an un-prefixed key, so one
 *             tenant can never read another's entry. A global target uses a
 *             separate `g:` prefix and a distinct API, so the two can never be
 *             confused.
 *
 *   Phase 3 — INVALIDATION. Because every key carries its owner prefix, a
 *             write can evict exactly what it changed: one key, one target for
 *             one tenant, or a tenant's entire cached footprint across every
 *             target — all via prefix sweeps. TTL remains the correctness
 *             backstop; explicit invalidation just makes writes visible sooner.
 *
 * SCOPE: like the primitive it builds on, this is a PER-NODE cache. It is only
 * ever used for data that is safe to serve slightly stale for the target's TTL.
 * Anything that must be consistent across nodes stays in MySQL.
 */

import { createCache, type TtlCache } from "@/lib/cache"
import { getCurrentTenant } from "@/lib/tenant-context"

// ---------------------------------------------------------------------------
// Phase 1 — the cache-candidate catalog.
// ---------------------------------------------------------------------------

/**
 * `tenant` — every entry is owned by exactly one tenant and keyed by its id.
 * `global` — genuinely tenant-agnostic reference data (no tenant rows).
 */
export type CacheScope = "tenant" | "global"

export type CacheTargetDef = {
  /** Stable label; also the underlying cache namespace (`safe-cache:<name>`). */
  name: string
  scope: CacheScope
  /** Default TTL for entries in this target. */
  ttlMs: number
  /** Hard per-node entry cap (bounds memory across all tenants/keys). */
  maxEntries: number
  description: string
}

/**
 * The reviewed set of things it is safe to cache. Keys are the ergonomic
 * handles callers pass; `name` is the on-the-wire namespace. TTLs are short for
 * security-sensitive targets (permissions) and longer for slow-changing
 * reference data (master data).
 */
export const CACHE_TARGETS = {
  /** SPEC 37/39 — resolved tenant configuration / settings rows. */
  config: {
    name: "config",
    scope: "tenant",
    ttlMs: 60_000,
    maxEntries: 5_000,
    description: "Per-tenant configuration and settings rows.",
  },
  /** SPEC 8 — a user's effective permission matrix (within a tenant). */
  permissions: {
    name: "permissions",
    scope: "tenant",
    ttlMs: 30_000,
    maxEntries: 50_000,
    description: "Effective per-user permission matrices, scoped by tenant.",
  },
  /** SPEC 17/18 — a tenant's plan entitlements contract. */
  entitlements: {
    name: "entitlements",
    scope: "tenant",
    ttlMs: 60_000,
    maxEntries: 5_000,
    description: "Per-tenant feature entitlements resolved from the plan.",
  },
  /** Slow-changing reference / master data lists. */
  masterData: {
    name: "master-data",
    scope: "tenant",
    ttlMs: 300_000,
    maxEntries: 10_000,
    description: "Per-tenant master / reference data lists.",
  },
  /** Aggregated dashboard metrics (safe to serve slightly stale). */
  dashboardMetrics: {
    name: "dashboard-metrics",
    scope: "tenant",
    ttlMs: 30_000,
    maxEntries: 10_000,
    description: "Per-tenant dashboard metric aggregates.",
  },
  /** Frequently-accessed report result sets. */
  reports: {
    name: "reports",
    scope: "tenant",
    ttlMs: 60_000,
    maxEntries: 10_000,
    description: "Per-tenant, frequently-accessed report results.",
  },
} as const satisfies Record<string, CacheTargetDef>

export type CacheTargetKey = keyof typeof CACHE_TARGETS

// ---------------------------------------------------------------------------
// Phase 2 — the abstraction: safe key building + cache access.
// ---------------------------------------------------------------------------

type BoundTarget = { def: CacheTargetDef; cache: TtlCache<unknown> }

// One underlying TtlCache per target, created (and registered for metrics) up
// front so the observability surface always sees every target.
const bound = new Map<CacheTargetKey, BoundTarget>()
for (const key of Object.keys(CACHE_TARGETS) as CacheTargetKey[]) {
  const def = CACHE_TARGETS[key]
  bound.set(key, {
    def,
    cache: createCache<unknown>(`safe-cache:${def.name}`, {
      maxEntries: def.maxEntries,
      defaultTtlMs: def.ttlMs,
    }),
  })
}

function targetFor(key: CacheTargetKey): BoundTarget {
  const b = bound.get(key)
  if (!b) throw new Error(`Unknown cache target "${String(key)}"`)
  return b
}

/**
 * The mandatory owner prefix for a tenant's entries. Every tenant-scoped key
 * begins with this, so a prefix sweep evicts a whole tenant and no two tenants
 * can ever collide on a key. Not exported: callers must go through the helpers.
 */
function tenantPrefix(tenantId: number): string {
  return `t:${tenantId}:`
}

function isValidTenantId(tenantId: unknown): tenantId is number {
  return typeof tenantId === "number" && Number.isInteger(tenantId) && tenantId > 0
}

/**
 * Cache a value for a tenant whose id the caller already holds and trusts
 * (typically `requireCurrentTenantId()` or an authorized platform path). The id
 * is the OWNER of the data and is folded into the key, so the value can never
 * be served to another tenant.
 *
 * Fail-closed: given a non-positive / non-integer id there is no safe key to
 * store under, so the loader is run WITHOUT caching rather than risk a shared
 * bucket.
 */
export async function cachedForTenant<V>(
  target: CacheTargetKey,
  tenantId: number,
  subkey: string,
  loader: () => Promise<V>,
  ttlMs?: number,
): Promise<V> {
  const { def, cache } = targetFor(target)
  if (def.scope !== "tenant") {
    throw new Error(`Cache target "${def.name}" is global; use cachedGlobal() instead`)
  }
  if (!isValidTenantId(tenantId)) {
    return loader()
  }
  return cache.getOrLoad(tenantPrefix(tenantId) + subkey, loader, ttlMs) as Promise<V>
}

/**
 * Convenience wrapper around `cachedForTenant` that derives the owner tenant
 * from the verified request context (lib/tenant-context.ts). When there is no
 * tenant in context (system / pre-auth / cron-before-runForTenant) there is no
 * safe key, so the loader runs uncached — never under a shared bucket.
 */
export async function cached<V>(
  target: CacheTargetKey,
  subkey: string,
  loader: () => Promise<V>,
  ttlMs?: number,
): Promise<V> {
  const tenant = getCurrentTenant()
  if (!tenant) return loader()
  return cachedForTenant(target, tenant.tenantId, subkey, loader, ttlMs)
}

/**
 * Cache a genuinely tenant-agnostic value under a distinct `g:` prefix. Kept as
 * a separate API (and refused for tenant-scoped targets) so global caching is
 * always a deliberate choice, never an accidental omission of the tenant id.
 */
export async function cachedGlobal<V>(
  target: CacheTargetKey,
  subkey: string,
  loader: () => Promise<V>,
  ttlMs?: number,
): Promise<V> {
  const { def, cache } = targetFor(target)
  if (def.scope !== "global") {
    throw new Error(`Cache target "${def.name}" is tenant-scoped; use cachedForTenant()/cached() instead`)
  }
  return cache.getOrLoad(`g:${subkey}`, loader, ttlMs) as Promise<V>
}

// ---------------------------------------------------------------------------
// Phase 3 — invalidation.
// ---------------------------------------------------------------------------

/** Evict one exact key from one tenant-scoped target after a targeted write. */
export function invalidateTenantKey(target: CacheTargetKey, tenantId: number, subkey: string): void {
  if (!isValidTenantId(tenantId)) return
  targetFor(target).cache.delete(tenantPrefix(tenantId) + subkey)
}

/** Evict every entry a tenant owns in ONE target (e.g. drop its config cache). */
export function invalidateTenantTarget(target: CacheTargetKey, tenantId: number): number {
  if (!isValidTenantId(tenantId)) return 0
  const { def, cache } = targetFor(target)
  if (def.scope !== "tenant") return 0
  return cache.deleteByPrefix(tenantPrefix(tenantId))
}

/**
 * Evict a tenant's ENTIRE cached footprint across every tenant-scoped target.
 * Use for coarse tenant-level events (plan change touching several caches,
 * tenant suspension) where it is simpler and safer to drop everything the
 * tenant owns than to enumerate keys.
 */
export function invalidateTenant(tenantId: number): number {
  if (!isValidTenantId(tenantId)) return 0
  let removed = 0
  for (const { def, cache } of bound.values()) {
    if (def.scope === "tenant") removed += cache.deleteByPrefix(tenantPrefix(tenantId))
  }
  return removed
}

/**
 * Clear an entire target for ALL tenants. Reserved for writes whose blast
 * radius genuinely spans tenants (e.g. editing a shared plan definition that
 * changes many tenants' entitlements) or a user-level permission write that has
 * no single tenant id to scope by. Coarse but always safe.
 */
export function invalidateTargetForAllTenants(target: CacheTargetKey): void {
  targetFor(target).cache.clear()
}

/** Convenience: evict everything owned by the tenant currently in context. */
export function invalidateCurrentTenant(): number {
  const tenant = getCurrentTenant()
  return tenant ? invalidateTenant(tenant.tenantId) : 0
}
