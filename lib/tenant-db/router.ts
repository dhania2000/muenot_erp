import "server-only"
/**
 * Tenant connection router.
 * ---------------------------------------------------------------------------
 * The single place that turns a trusted tenant routing profile into a live
 * connection pool. It owns a process-wide cache of pools keyed by
 * `ConnectionProfile.poolKey` and enforces, on every resolution:
 *
 *   - NO CROSS-TENANT REUSE : an isolated pool (separate_schema /
 *     dedicated_database) is bound to exactly one tenant for its lifetime; a key
 *     collision that would hand tenant B a pool created for tenant A throws.
 *   - NO REGION DRIFT        : the region a cached pool was created for must
 *     match the region the tenant is currently configured for; a mismatch
 *     evicts nothing silently — it throws so the request fails closed.
 *
 * The pool FACTORY is injectable so the concurrency/isolation guarantees can be
 * unit-tested without a real MySQL server.
 */

import mysql from "mysql2/promise"
import { pool as sharedPool, query as sharedQuery } from "@/lib/db"
import {
  type ConnectionProfile,
  assertPoolUsable,
  isolatesConnection,
  resolveConnectionProfile,
  TenantRoutingError,
  type ProfileInputs,
} from "./model"
import { resolveDedicatedDbConfig, resolveSharedDbConfig, type DbConnectionConfig } from "./secret-ref"

/** The minimal surface the router needs from a pool — satisfied by mysql2. */
export interface RoutedPool {
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>
  end?(): Promise<void>
}

export type PoolFactory = (config: DbConnectionConfig) => RoutedPool

type CacheEntry = {
  pool: RoutedPool
  tenantId: number
  region: string | null
  deploymentModel: ConnectionProfile["deploymentModel"]
  /** Whether this entry wraps the app-wide shared pool (never end() it). */
  shared: boolean
}

declare global {
  // eslint-disable-next-line no-var
  var __tenantDbPools: Map<string, CacheEntry> | undefined
}

const cache: Map<string, CacheEntry> = globalThis.__tenantDbPools ?? new Map<string, CacheEntry>()
if (process.env.NODE_ENV !== "production") globalThis.__tenantDbPools = cache

function defaultFactory(config: DbConnectionConfig): RoutedPool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    waitForConnections: true,
    connectionLimit: 5,
    // Bound both sockets and queued work for every isolated tenant. An
    // unlimited queue lets one offline database exhaust process memory.
    queueLimit: 100,
    maxIdle: 5,
    idleTimeout: 60_000,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    dateStrings: true,
  }) as unknown as RoutedPool
}

let factory: PoolFactory = defaultFactory

function maxIsolatedPools(): number {
  const configured = Number(process.env.TENANT_DB_MAX_POOLS)
  if (!Number.isInteger(configured) || configured < 1) return 64
  return Math.min(configured, 256)
}

export class TenantPoolCapacityError extends Error {
  readonly code = "TENANT_DB_POOL_CAPACITY"
  readonly status = 503

  constructor() {
    super("Tenant database pool capacity is exhausted.")
    this.name = "TenantPoolCapacityError"
  }
}

/** Test hook: swap the pool factory. Returns the previous one. */
export function __setPoolFactory(next: PoolFactory): PoolFactory {
  const prev = factory
  factory = next
  return prev
}

/** Test hook: clear the pool cache (does not end the shared pool). */
export function __resetTenantDbPools(): void {
  for (const entry of cache.values()) {
    if (!entry.shared && entry.pool.end) entry.pool.end().catch(() => {})
  }
  cache.clear()
}

/** Build the physical connection config for a resolved profile. */
function configForProfile(profile: ConnectionProfile): DbConnectionConfig {
  switch (profile.deploymentModel) {
    case "shared_database":
      return resolveSharedDbConfig()
    case "separate_schema":
      // Same server credentials, tenant's own schema/database.
      return { ...resolveSharedDbConfig({ database: profile.schema }), region: profile.region }
    case "dedicated_database": {
      const cfg = resolveDedicatedDbConfig(profile.connectionRef!)
      if (cfg.database !== profile.schema) {
        throw new TenantRoutingError("Dedicated database name does not match the tenant routing profile.", 409)
      }
      // The DSN's declared region (if any) is the physical truth; fall back to
      // the tenant's configured region when the DSN does not declare one.
      return { ...cfg, region: cfg.region ?? profile.region }
    }
  }
}

/**
 * Resolve (or create) the pool that serves this profile. Enforces cross-tenant
 * and region-drift invariants against any cached entry before returning it.
 */
export function getPoolForProfile(profile: ConnectionProfile): RoutedPool {
  const existing = cache.get(profile.poolKey)
  if (existing) {
    assertPoolUsable(profile, existing)
    return existing.pool
  }

  // shared_database is served by the app-wide pool so the whole app shares one
  // connection budget; it is cached as `shared` so it is never end()ed.
  if (profile.deploymentModel === "shared_database") {
    const entry: CacheEntry = {
      pool: sharedPool as unknown as RoutedPool,
      tenantId: profile.tenantId,
      region: profile.region,
      deploymentModel: profile.deploymentModel,
      shared: true,
    }
    cache.set(profile.poolKey, entry)
    return entry.pool
  }

  let isolatedCount = 0
  for (const entry of cache.values()) if (!entry.shared) isolatedCount++
  if (isolatedCount >= maxIsolatedPools()) throw new TenantPoolCapacityError()

  const config = configForProfile(profile)
  // Validate the physical target before allocating sockets. A mismatched DSN
  // must not leave a live, uncached pool behind on the failure path.
  assertPoolUsable(profile, {
    tenantId: profile.tenantId,
    region: config.region,
    deploymentModel: profile.deploymentModel,
  })
  const pool = factory(config)
  const entry: CacheEntry = {
    pool,
    tenantId: profile.tenantId,
    region: config.region,
    deploymentModel: profile.deploymentModel,
    shared: false,
  }
  cache.set(profile.poolKey, entry)
  return pool
}

/** Resolve a profile from trusted inputs and return its pool. */
export function getPoolForTenant(inputs: ProfileInputs): RoutedPool {
  const profile = resolveConnectionProfile(inputs)
  return getPoolForProfile(profile)
}

/**
 * Execute a query against the tenant's routed connection. For shared_database
 * this goes through the app-wide `query` (keeping the tenant-isolation guard and
 * slow-query instrumentation); isolated models query their dedicated pool
 * directly (their whole schema/instance belongs to the one tenant).
 */
export async function queryForTenant<T = any>(
  inputs: ProfileInputs,
  sql: string,
  params: any[] = [],
): Promise<T> {
  const profile = resolveConnectionProfile(inputs)
  if (!isolatesConnection(profile.deploymentModel)) {
    return sharedQuery<T>(sql, params)
  }
  const pool = getPoolForProfile(profile)
  const [rows] = await pool.query<T>(sql, params)
  return rows as T
}

/** Number of pools currently cached — observability / test assertions. */
export function cachedPoolCount(): number {
  return cache.size
}

/**
 * Explicitly retire an isolated tenant pool after routing/credential changes.
 * Callers must first quiesce in-flight work for this tenant; this function does
 * not silently transfer queries to another database or close the shared pool.
 */
export async function retireTenantPools(tenantId: number): Promise<number> {
  const retiring: RoutedPool[] = []
  for (const [key, entry] of cache) {
    if (entry.shared || entry.tenantId !== tenantId) continue
    cache.delete(key)
    retiring.push(entry.pool)
  }
  await Promise.all(retiring.map((pool) => pool.end?.()))
  return retiring.length
}
