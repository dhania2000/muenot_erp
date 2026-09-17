import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  guardQuery,
  hasTenantPredicate,
  inspect,
  isolationMode,
  referencedTables,
  scopedTablesTouched,
  TenantIsolationError,
} from "@/lib/tenant-guard"
import { setCurrentTenant } from "@/lib/tenant-context"
import { TENANT_OWNED_TABLES } from "@/lib/tenant-tables"

/**
 * SPEC 2 — Phase 3/4: automated + penetration-style validation of the
 * fail-closed data-access guard. These tests never touch a database; they
 * exercise the pure inspection logic that decides whether a statement can leak
 * across tenants.
 */

const ORIGINAL_MODE = process.env.TENANT_ISOLATION_MODE

beforeEach(() => {
  // No tenant in context by default; individual tests opt in.
  setCurrentTenant(null)
})

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.TENANT_ISOLATION_MODE
  else process.env.TENANT_ISOLATION_MODE = ORIGINAL_MODE
  setCurrentTenant(null)
})

describe("referencedTables", () => {
  it("extracts FROM / JOIN / UPDATE / DELETE / INSERT targets", () => {
    expect(referencedTables("SELECT * FROM sales_leads")).toContain("sales_leads")
    expect(referencedTables("SELECT * FROM `clients` c JOIN sales_companies s ON s.id = c.company_id")).toEqual(
      expect.arrayContaining(["clients", "sales_companies"]),
    )
    expect(referencedTables("UPDATE sales_quotations SET status = ?")).toContain("sales_quotations")
    expect(referencedTables("DELETE FROM sales_contracts WHERE id = ?")).toContain("sales_contracts")
    expect(referencedTables("INSERT INTO clients (a) VALUES (?)")).toContain("clients")
  })
})

describe("scopedTablesTouched", () => {
  it("flags every registered tenant-owned table", () => {
    for (const t of TENANT_OWNED_TABLES) {
      expect(scopedTablesTouched(`SELECT * FROM ${t}`)).toContain(t)
    }
  })

  it("also protects the identity table (users)", () => {
    expect(scopedTablesTouched("SELECT * FROM users WHERE id = ?")).toContain("users")
  })

  it("ignores non-tenant / global tables", () => {
    expect(scopedTablesTouched("SELECT * FROM modules")).toHaveLength(0)
    expect(scopedTablesTouched("SELECT * FROM features")).toHaveLength(0)
  })

  it("never flags DDL or information_schema probes", () => {
    expect(scopedTablesTouched("ALTER TABLE sales_leads ADD COLUMN x INT")).toHaveLength(0)
    expect(
      scopedTablesTouched("SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_leads'"),
    ).toHaveLength(0)
  })

  it("catches a bare table reference the FROM/JOIN regex might miss (backstop)", () => {
    // Table named only inside a parenthesized subquery form.
    expect(scopedTablesTouched("SELECT * FROM (SELECT id FROM sales_leads) x")).toContain("sales_leads")
  })
})

describe("hasTenantPredicate", () => {
  it("is true only when tenant_id is constrained", () => {
    expect(hasTenantPredicate("SELECT * FROM sales_leads WHERE tenant_id = ?")).toBe(true)
    expect(hasTenantPredicate("SELECT * FROM sales_leads WHERE status = ?")).toBe(false)
  })
})

describe("inspect (core isolation decision)", () => {
  it("returns null when no tenant is in context (system / pre-auth / cron)", () => {
    process.env.TENANT_ISOLATION_MODE = "enforce"
    setCurrentTenant(null)
    expect(inspect("SELECT * FROM sales_leads")).toBeNull()
  })

  it("returns null when the guard is disabled", () => {
    process.env.TENANT_ISOLATION_MODE = "off"
    setCurrentTenant({ tenantId: 7 })
    expect(inspect("SELECT * FROM sales_leads")).toBeNull()
  })

  it("FLAGS an unscoped read of a tenant-owned table (cross-tenant leak)", () => {
    process.env.TENANT_ISOLATION_MODE = "enforce"
    setCurrentTenant({ tenantId: 7 })
    const v = inspect("SELECT * FROM sales_leads WHERE status = 'New'")
    expect(v).not.toBeNull()
    expect(v?.tables).toContain("sales_leads")
    expect(v?.tenantId).toBe(7)
  })

  it("ALLOWS the same read once it constrains tenant_id", () => {
    process.env.TENANT_ISOLATION_MODE = "enforce"
    setCurrentTenant({ tenantId: 7 })
    expect(inspect("SELECT * FROM sales_leads WHERE tenant_id = ? AND status = 'New'")).toBeNull()
  })
})

describe("guardQuery enforcement", () => {
  it("throws in enforce mode on an unscoped tenant-owned query", () => {
    process.env.TENANT_ISOLATION_MODE = "enforce"
    setCurrentTenant({ tenantId: 3 })
    expect(() => guardQuery("SELECT * FROM clients")).toThrow(TenantIsolationError)
  })

  it("does NOT throw in report mode, even on a violation", () => {
    process.env.TENANT_ISOLATION_MODE = "report"
    setCurrentTenant({ tenantId: 3 })
    expect(() => guardQuery("SELECT * FROM clients")).not.toThrow()
  })

  it("does not throw when the query is properly scoped", () => {
    process.env.TENANT_ISOLATION_MODE = "enforce"
    setCurrentTenant({ tenantId: 3 })
    expect(() => guardQuery("SELECT * FROM clients WHERE tenant_id = ?")).not.toThrow()
  })
})

describe("isolationMode parsing", () => {
  it("defaults to report for unknown / unset values", () => {
    delete process.env.TENANT_ISOLATION_MODE
    expect(isolationMode()).toBe("report")
    process.env.TENANT_ISOLATION_MODE = "banana"
    expect(isolationMode()).toBe("report")
  })

  it("honors off and enforce", () => {
    process.env.TENANT_ISOLATION_MODE = "off"
    expect(isolationMode()).toBe("off")
    process.env.TENANT_ISOLATION_MODE = "enforce"
    expect(isolationMode()).toBe("enforce")
  })
})
