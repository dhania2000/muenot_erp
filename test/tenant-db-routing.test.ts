import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Tenant connection routing — the core isolation proof for Spec3.
 * Verifies pool keys keep tenants apart, that the router creates exactly one
 * pool per distinct tenant target under concurrent resolution, and that neither
 * cross-tenant connection reuse nor region drift can slip through.
 *
 * The shared pool + query are mocked so nothing touches a real MySQL server;
 * the injectable pool factory lets us trace which physical config each tenant
 * actually resolved to.
 */

const dbMocks = vi.hoisted(() => ({
  sharedPool: { query: async () => [[{ ok: 1 }], []] },
}))
vi.mock("@/lib/db", () => ({
  pool: dbMocks.sharedPool,
  query: async () => [{ ok: 1 }],
}))
const sharedPool = dbMocks.sharedPool

import {
  CrossTenantConnectionError,
  RegionDriftError,
  TenantRoutingError,
  assertPoolUsable,
  poolKeyForProfile,
  resolveConnectionProfile,
  type ProfileInputs,
} from "@/lib/tenant-db/model"
import {
  __resetTenantDbPools,
  __setPoolFactory,
  cachedPoolCount,
  getPoolForProfile,
  getPoolForTenant,
  queryForTenant,
  type RoutedPool,
} from "@/lib/tenant-db/router"
import type { DbConnectionConfig } from "@/lib/tenant-db/secret-ref"

type TaggedPool = RoutedPool & { __config: DbConnectionConfig }
let created: DbConnectionConfig[] = []

function factory(config: DbConnectionConfig): TaggedPool {
  created.push(config)
  return {
    __config: config,
    query: vi.fn(async () => [[{ db: config.database ?? "?", host: config.host }], []]),
    end: vi.fn(async () => {}),
  }
}

beforeAll(() => {
  // Shared server env for separate_schema resolution.
  process.env.DB_HOST = "shared-host"
  process.env.DB_PORT = "3306"
  process.env.DB_USER = "app"
  process.env.DB_PASSWORD = "secret"
  process.env.DB_NAME = "muenot"
  process.env.DB_REGION = "eu-west-1"
  // Managed secret references (DSNs) for two dedicated tenants, both EU.
  process.env.TENANT_A_DSN = "mysql://ua:pa@host-a:3306/tenant_a?region=eu-west-1"
  process.env.TENANT_B_DSN = "mysql://ub:pb@host-b:3306/tenant_b?region=eu-west-1"
})

beforeEach(() => {
  created = []
  __resetTenantDbPools()
  __setPoolFactory(factory)
})
afterEach(() => __resetTenantDbPools())

describe("pool keys keep tenants apart", () => {
  it("shares one key across tenants for shared_database (row-level isolation)", () => {
    const a = poolKeyForProfile({ tenantId: 1, deploymentModel: "shared_database", dbRegion: "eu-west-1" })
    const b = poolKeyForProfile({ tenantId: 2, deploymentModel: "shared_database", dbRegion: "eu-west-1" })
    expect(a).toBe(b)
  })

  it("gives every tenant a distinct key for separate_schema and dedicated_database", () => {
    const s1 = poolKeyForProfile({ tenantId: 1, deploymentModel: "separate_schema", schema: "t1", dbRegion: "eu-west-1" })
    const s2 = poolKeyForProfile({ tenantId: 2, deploymentModel: "separate_schema", schema: "t2", dbRegion: "eu-west-1" })
    const d1 = poolKeyForProfile({ tenantId: 1, deploymentModel: "dedicated_database", connectionRef: "TENANT_A_DSN", dbRegion: "eu-west-1" })
    const d2 = poolKeyForProfile({ tenantId: 2, deploymentModel: "dedicated_database", connectionRef: "TENANT_B_DSN", dbRegion: "eu-west-1" })
    expect(new Set([s1, s2, d1, d2]).size).toBe(4)
  })

  it("keys by region so the same tenant target in two regions never shares a pool", () => {
    const eu = poolKeyForProfile({ tenantId: 1, deploymentModel: "separate_schema", schema: "t1", dbRegion: "eu-west-1" })
    const us = poolKeyForProfile({ tenantId: 1, deploymentModel: "separate_schema", schema: "t1", dbRegion: "us-east-1" })
    expect(eu).not.toBe(us)
  })
})

describe("resolveConnectionProfile fails closed on misconfiguration", () => {
  it("requires a schema for separate_schema", () => {
    expect(() => resolveConnectionProfile({ tenantId: 1, deploymentModel: "separate_schema" })).toThrow(TenantRoutingError)
  })
  it("requires a connection ref for dedicated_database", () => {
    expect(() => resolveConnectionProfile({ tenantId: 1, deploymentModel: "dedicated_database", schema: "t1" })).toThrow(
      TenantRoutingError,
    )
  })
  it("rejects a db region that violates the tenant's residency anchor", () => {
    expect(() =>
      resolveConnectionProfile({
        tenantId: 1,
        deploymentModel: "separate_schema",
        schema: "t1",
        dbRegion: "us-east-1",
        dataRegion: "eu-west-1",
      }),
    ).toThrow(TenantRoutingError)
  })
  it("rejects a schema name that is not a safe MySQL identifier", () => {
    expect(() =>
      resolveConnectionProfile({ tenantId: 1, deploymentModel: "separate_schema", schema: "bad-name;" }),
    ).toThrow(TenantRoutingError)
  })
})

describe("assertPoolUsable guards reuse and drift", () => {
  const profile = resolveConnectionProfile({
    tenantId: 1,
    deploymentModel: "dedicated_database",
    schema: "tenant_a",
    connectionRef: "TENANT_A_DSN",
    dbRegion: "eu-west-1",
    dataRegion: "eu-west-1",
  })

  it("refuses to serve a pool bound to another tenant", () => {
    expect(() =>
      assertPoolUsable(profile, { tenantId: 999, region: "eu-west-1", deploymentModel: "dedicated_database" }),
    ).toThrow(CrossTenantConnectionError)
  })

  it("refuses a pool whose region has drifted from the configured region", () => {
    expect(() =>
      assertPoolUsable(profile, { tenantId: 1, region: "eu-central-1", deploymentModel: "dedicated_database" }),
    ).toThrow(RegionDriftError)
  })

  it("accepts a pool bound to the same tenant in the same region", () => {
    expect(() =>
      assertPoolUsable(profile, { tenantId: 1, region: "eu-west-1", deploymentModel: "dedicated_database" }),
    ).not.toThrow()
  })
})

describe("router: no cross-tenant reuse or region drift under concurrency", () => {
  const tenantA: ProfileInputs = {
    tenantId: 1,
    deploymentModel: "dedicated_database",
    schema: "tenant_a",
    connectionRef: "TENANT_A_DSN",
    dbRegion: "eu-west-1",
    dataRegion: "eu-west-1",
  }
  const tenantB: ProfileInputs = {
    tenantId: 2,
    deploymentModel: "dedicated_database",
    schema: "tenant_b",
    connectionRef: "TENANT_B_DSN",
    dbRegion: "eu-west-1",
    dataRegion: "eu-west-1",
  }

  it("creates exactly one pool per tenant and never hands a tenant the other's pool", async () => {
    const calls = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? tenantA : tenantB))
    const pools = await Promise.all(calls.map((inputs) => Promise.resolve(getPoolForTenant(inputs) as TaggedPool)))

    // One physical pool per distinct tenant target.
    expect(cachedPoolCount()).toBe(2)
    expect(created).toHaveLength(2)

    // Every tenant-A request got tenant A's host, every tenant-B request got B's.
    pools.forEach((pool, i) => {
      const expectedHost = i % 2 === 0 ? "host-a" : "host-b"
      expect(pool.__config.host).toBe(expectedHost)
    })

    // All tenant-A pools are the identical cached instance (and likewise for B).
    const aPools = new Set(pools.filter((_, i) => i % 2 === 0))
    const bPools = new Set(pools.filter((_, i) => i % 2 === 1))
    expect(aPools.size).toBe(1)
    expect(bPools.size).toBe(1)
    // A's instance and B's instance are different objects.
    expect([...aPools][0]).not.toBe([...bPools][0])
  })

  it("serves every shared_database tenant from the single app-wide pool without invoking the factory", async () => {
    const shared: ProfileInputs = { tenantId: 7, deploymentModel: "shared_database", dbRegion: "eu-west-1" }
    const shared2: ProfileInputs = { tenantId: 8, deploymentModel: "shared_database", dbRegion: "eu-west-1" }
    const pools = await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve(getPoolForTenant(i % 2 === 0 ? shared : shared2))),
    )
    expect(created).toHaveLength(0)
    expect(cachedPoolCount()).toBe(1)
    for (const pool of pools) expect(pool).toBe(sharedPool)
  })

  it("throws region drift when a cached pool's region no longer matches the tenant config", () => {
    // Prime the cache in EU.
    getPoolForProfile(resolveConnectionProfile(tenantA))
    // The same tenant + ref + region key, but the DSN now declares a different
    // physical region: build a profile whose poolKey collides but whose region
    // differs, so the cached entry is detected as drifted.
    const drifted = { ...resolveConnectionProfile(tenantA), region: "eu-central-1" }
    expect(() => getPoolForProfile(drifted)).toThrow(RegionDriftError)
  })
})

describe("queryForTenant routes to the correct connection", () => {
  it("uses the shared query path for shared_database", async () => {
    const rows = await queryForTenant({ tenantId: 1, deploymentModel: "shared_database" }, "SELECT 1")
    expect(rows).toEqual([{ ok: 1 }])
    expect(created).toHaveLength(0)
  })

  it("uses the tenant's dedicated pool for dedicated_database", async () => {
    const rows = await queryForTenant<any[]>(
      { tenantId: 1, deploymentModel: "dedicated_database", schema: "tenant_a", connectionRef: "TENANT_A_DSN", dbRegion: "eu-west-1", dataRegion: "eu-west-1" },
      "SELECT 1",
    )
    expect(created).toHaveLength(1)
    expect(rows[0].host).toBe("host-a")
  })
})
