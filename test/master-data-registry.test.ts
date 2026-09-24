import { describe, expect, it } from "vitest"
import { MASTER_SOURCES, MASTER_KINDS, getMasterSource } from "@/lib/master-data/registry"
import { TENANT_OWNED_TABLES } from "@/lib/tenant-tables"

/**
 * SPEC 90 Phase 4 — reference + backward-compatibility validation.
 *
 * These tests exercise the pure routing registry that decides where every
 * master physically lives. They never touch a database; they assert the
 * architectural invariants that keep the centralized master data both correct
 * (single source of truth) and backward compatible (delegated masters still
 * point at their owning module's authoritative table).
 */

describe("master registry integrity", () => {
  it("registers every declared master kind exactly once", () => {
    expect(new Set(MASTER_KINDS).size).toBe(MASTER_KINDS.length)
    for (const kind of MASTER_KINDS) {
      expect(getMasterSource(kind).kind).toBe(kind)
    }
  })

  it("throws on unknown kinds", () => {
    // @ts-expect-error deliberately invalid
    expect(() => getMasterSource("not_a_master")).toThrow()
  })

  it("gives every master a backing table and code/name/active columns", () => {
    for (const src of Object.values(MASTER_SOURCES)) {
      expect(src.table).toBeTruthy()
      expect(src.codeCol).toBeTruthy()
      expect(src.nameCol).toBeTruthy()
      expect(src.activeCol).toBeTruthy()
      expect(src.activeTrue).toBeTruthy()
    }
  })
})

describe("backing-mode invariants", () => {
  it("keeps a single source of truth: no two writable masters share a table", () => {
    const writableTables = Object.values(MASTER_SOURCES)
      .filter((s) => s.writable)
      .map((s) => s.table)
    expect(new Set(writableTables).size).toBe(writableTables.length)
  })

  it("makes delegated masters read-only (owning module stays authoritative)", () => {
    for (const src of Object.values(MASTER_SOURCES)) {
      if (src.mode === "delegated") expect(src.writable).toBe(false)
    }
  })

  it("delegates to the expected existing module tables (backward compatibility)", () => {
    expect(MASTER_SOURCES.departments.table).toBe("hr_departments")
    expect(MASTER_SOURCES.designations.table).toBe("hr_designations")
    expect(MASTER_SOURCES.tax_codes.table).toBe("finance_tax_rates")
  })
})

describe("tenant scoping vs global catalogue", () => {
  it("marks tenant-mode masters as tenant-scoped and registers them in the guard", () => {
    for (const src of Object.values(MASTER_SOURCES)) {
      if (src.mode === "tenant") {
        expect(src.tenantScoped).toBe(true)
        expect(TENANT_OWNED_TABLES as readonly string[]).toContain(src.table)
      }
    }
  })

  it("keeps global reference catalogue OUT of the tenant guard", () => {
    for (const src of Object.values(MASTER_SOURCES)) {
      if (src.mode === "global") {
        expect(src.tenantScoped).toBe(false)
        expect(TENANT_OWNED_TABLES as readonly string[]).not.toContain(src.table)
      }
    }
  })

  it("only tenant-owned business masters are guarded (cost centres, locations, categories)", () => {
    const tenantMasters = Object.values(MASTER_SOURCES)
      .filter((s) => s.mode === "tenant")
      .map((s) => s.kind)
      .sort()
    expect(tenantMasters).toEqual(["categories", "cost_centers", "locations"])
  })
})

describe("hierarchical masters expose a parent link", () => {
  it("states/cities/categories declare a parent column", () => {
    expect(MASTER_SOURCES.states.parentCol).toBe("country_code")
    expect(MASTER_SOURCES.cities.parentCol).toBe("state_code")
    expect(MASTER_SOURCES.categories.parentCol).toBe("domain")
  })
})
