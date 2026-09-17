import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 2 — Phase 3/4: automated + penetration-style validation of the
 * tenant-scoped data-access helpers. We mock the DB layer to capture the exact
 * SQL + params each helper emits, proving that:
 *   - every read/write is constrained by tenant_id,
 *   - a forged id cannot reach another tenant's row (IDOR),
 *   - inserts stamp the acting tenant and cannot be overridden by the caller,
 *   - loaded rows are rejected when they belong to another tenant.
 */

const calls: { sql: string; params: any[] }[] = []
let nextResult: any = []

// Capture every statement the helpers would run instead of hitting MySQL.
vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    return nextResult
  }),
}))

// forEachActiveTenant pulls the tenant list; keep it out of the DB.
vi.mock("@/lib/tenant-service", () => ({
  listTenants: vi.fn(async () => [
    { id: 1, slug: "muenot", name: "Muenot", status: "active" },
    { id: 2, slug: "acme", name: "Acme", status: "active" },
    { id: 3, slug: "dormant", name: "Dormant", status: "suspended" },
  ]),
}))

import {
  assertSameTenant,
  CrossTenantAccessError,
  currentTenantId,
  forEachActiveTenant,
  runForTenant,
  scopedWhere,
  tenantDelete,
  tenantFindById,
  tenantInsert,
  tenantSelect,
  tenantUpdate,
} from "@/lib/tenant-scope"
import { setCurrentTenant } from "@/lib/tenant-context"

beforeEach(() => {
  calls.length = 0
  nextResult = []
  setCurrentTenant({ tenantId: 7, slug: "acme" })
})

afterEach(() => {
  setCurrentTenant(null)
  vi.clearAllMocks()
})

describe("scopedWhere", () => {
  it("emits a bare tenant filter when no extra where is given", () => {
    const { where, params } = scopedWhere("sales_leads")
    expect(where).toMatch(/WHERE `tenant_id` = \?/)
    expect(params).toEqual([7])
  })

  it("ANDs the tenant filter in front of a caller filter", () => {
    const { where, params } = scopedWhere("sales_leads", "status = ?", ["New"])
    expect(where).toBe("WHERE `tenant_id` = ? AND (status = ?)")
    expect(params).toEqual([7, "New"])
  })

  it("supports an alias for joins", () => {
    const { where } = scopedWhere("sales_leads", "", [], { alias: "l" })
    expect(where).toBe("WHERE l.tenant_id = ?")
  })

  it("refuses tables that are not registered as tenant-scoped", () => {
    expect(() => scopedWhere("modules")).toThrow(/not registered as tenant-scoped/)
  })
})

describe("tenantSelect / tenantFindById (read scoping + IDOR)", () => {
  it("always constrains tenant_id on list reads", async () => {
    await tenantSelect("sales_leads", { tail: "ORDER BY created_at DESC" })
    expect(calls[0].sql).toContain("`tenant_id` = ?")
    expect(calls[0].params).toEqual([7])
  })

  it("scopes a by-id lookup so a foreign id returns null (IDOR defense)", async () => {
    nextResult = [] // simulate: row 999 belongs to another tenant
    const row = await tenantFindById("sales_leads", 999)
    expect(row).toBeNull()
    expect(calls[0].sql).toContain("`tenant_id` = ?")
    // Both the id and the tenant must be in the WHERE params.
    expect(calls[0].params).toEqual([7, 999])
  })
})

describe("tenantInsert (write stamping)", () => {
  it("stamps the acting tenant id", async () => {
    nextResult = { insertId: 42, affectedRows: 1 }
    const res = await tenantInsert("sales_leads", { name: "Lead A" })
    expect(res.insertId).toBe(42)
    expect(calls[0].sql).toContain("tenant_id")
    expect(calls[0].params).toContain(7)
  })

  it("cannot be tricked into writing another tenant's id", async () => {
    nextResult = { insertId: 1, affectedRows: 1 }
    // Attacker supplies a foreign tenant_id in the payload.
    await tenantInsert("sales_leads", { name: "Lead A", tenant_id: 9999 })
    // The stamped value wins; the forged 9999 must not be the tenant param.
    expect(calls[0].params).toContain(7)
    expect(calls[0].params).not.toContain(9999)
  })
})

describe("tenantUpdate / tenantDelete (mutation scoping)", () => {
  it("ANDs tenant_id into an update so a forged id cannot cross tenants", async () => {
    nextResult = { affectedRows: 0 }
    const affected = await tenantUpdate("sales_leads", { status: "Won" }, "`id` = ?", [999])
    expect(affected).toBe(0)
    expect(calls[0].sql).toMatch(/UPDATE `sales_leads` SET/)
    expect(calls[0].sql).toContain("`tenant_id` = ?")
    expect(calls[0].params).toEqual(["Won", 7, 999])
  })

  it("ANDs tenant_id into a delete", async () => {
    nextResult = { affectedRows: 0 }
    await tenantDelete("sales_leads", "`id` = ?", [999])
    expect(calls[0].sql).toContain("`tenant_id` = ?")
    expect(calls[0].params).toEqual([7, 999])
  })
})

describe("assertSameTenant (post-load IDOR guard)", () => {
  it("accepts a row owned by the current tenant", () => {
    expect(() => assertSameTenant({ tenant_id: 7 })).not.toThrow()
    expect(() => assertSameTenant(7)).not.toThrow()
  })

  it("rejects a row owned by another tenant", () => {
    expect(() => assertSameTenant({ tenant_id: 8 })).toThrow(CrossTenantAccessError)
    expect(() => assertSameTenant(8)).toThrow(CrossTenantAccessError)
  })

  it("rejects a row with no tenant stamp", () => {
    expect(() => assertSameTenant({})).toThrow(CrossTenantAccessError)
    expect(() => assertSameTenant(null)).toThrow(CrossTenantAccessError)
  })
})

describe("background jobs", () => {
  it("runForTenant binds the tenant for the duration of the callback", async () => {
    setCurrentTenant(null)
    let seen: number | null = null
    await runForTenant({ tenantId: 5, slug: "x" }, async () => {
      seen = currentTenantId()
    })
    expect(seen).toBe(5)
    // Context restored afterwards.
    expect(() => currentTenantId()).toThrow()
  })

  it("forEachActiveTenant fans out only over ACTIVE tenants, scoped each time", async () => {
    setCurrentTenant(null)
    const seenTenants: number[] = []
    const res = await forEachActiveTenant(async (t) => {
      seenTenants.push(currentTenantId())
      expect(currentTenantId()).toBe(t.tenantId)
    })
    expect(res.processed).toBe(2) // muenot + acme, NOT the suspended one
    expect(res.failed).toBe(0)
    expect(seenTenants).toEqual([1, 2])
  })

  it("counts a failing tenant without aborting the sweep", async () => {
    setCurrentTenant(null)
    const res = await forEachActiveTenant(async (t) => {
      if (t.tenantId === 1) throw new Error("boom")
    })
    expect(res.processed).toBe(1)
    expect(res.failed).toBe(1)
  })
})
