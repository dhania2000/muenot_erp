import { describe, it, expect } from "vitest"
import {
  buildDataScopeSql,
  recordInDataScope,
  getDataDomain,
  isDataScopeKind,
  type DataDomain,
  type DataScopeContext,
} from "@/lib/data-scope-model"

/**
 * SPEC 10 — Phase 4: unauthorized record access.
 * ---------------------------------------------------------------------------
 * The whole point of data-level permissions is that a record OUTSIDE a user's
 * scope is invisible — both in list queries (the SQL predicate must exclude it)
 * and on a single loaded row (the record check must reject it). These tests pin
 * that behaviour for every scope kind and, critically, that the engine fails
 * CLOSED: a missing column or an empty assignment denies rather than leaking.
 */

const employees = getDataDomain("hr.employees")!

/** A context helper with sensible empty defaults. */
function ctx(partial: Partial<DataScopeContext> & { userId: number }): DataScopeContext {
  return {
    subordinateUserIds: [],
    assignedEntities: [],
    assignedBranches: [],
    ...partial,
  }
}

const ALL_COLS = new Set(["id", "user_id", "created_by", "entity", "branch", "work_location"])

describe("catalog", () => {
  it("recognises the valid scope kinds and rejects junk", () => {
    for (const k of ["none", "self", "team", "entity", "branch", "all"]) {
      expect(isDataScopeKind(k)).toBe(true)
    }
    expect(isDataScopeKind("owner")).toBe(false)
    expect(isDataScopeKind("")).toBe(false)
    expect(isDataScopeKind(undefined)).toBe(false)
  })

  it("exposes the hr.employees domain with owner/entity/branch anchors", () => {
    expect(employees.table).toBe("hr_employees")
    expect(employees.ownerColumns).toContain("user_id")
    expect(employees.entityColumns.length).toBeGreaterThan(0)
    expect(employees.branchColumns.length).toBeGreaterThan(0)
  })
})

describe("record access — self (Employee sees only own records)", () => {
  const me = ctx({ userId: 10 })

  it("allows the user's own record", () => {
    expect(recordInDataScope("self", employees, me, { user_id: 10, created_by: 99 })).toBe(true)
  })

  it("denies another employee's record", () => {
    expect(recordInDataScope("self", employees, me, { user_id: 11, created_by: 12 })).toBe(false)
  })

  it("matches on any owner column (created_by)", () => {
    expect(recordInDataScope("self", employees, me, { user_id: 11, created_by: 10 })).toBe(true)
  })
})

describe("record access — team (Manager sees team records)", () => {
  const manager = ctx({ userId: 1, subordinateUserIds: [2, 3, 4] })

  it("allows the manager's own record", () => {
    expect(recordInDataScope("team", employees, manager, { user_id: 1 })).toBe(true)
  })

  it("allows a direct/transitive report", () => {
    expect(recordInDataScope("team", employees, manager, { user_id: 3 })).toBe(true)
  })

  it("denies a peer outside the report chain", () => {
    expect(recordInDataScope("team", employees, manager, { user_id: 5 })).toBe(false)
  })

  it("denies when the row carries no owner column at all (fail closed)", () => {
    expect(recordInDataScope("team", employees, manager, { id: 500 })).toBe(false)
  })
})

describe("record access — entity (HR/Finance see assigned entities)", () => {
  const hr = ctx({ userId: 7, assignedEntities: ["E1", "E2"] })

  it("allows a record in an assigned entity", () => {
    expect(recordInDataScope("entity", employees, hr, { entity: "E2", user_id: 999 })).toBe(true)
  })

  it("denies a record in an unassigned entity", () => {
    expect(recordInDataScope("entity", employees, hr, { entity: "E9", user_id: 999 })).toBe(false)
  })

  it("compares by value across string/number types", () => {
    const numeric = ctx({ userId: 7, assignedEntities: [42] })
    expect(recordInDataScope("entity", getDataDomain("finance.entities")!, numeric, { id: 42 })).toBe(true)
    expect(recordInDataScope("entity", getDataDomain("finance.entities")!, numeric, { id: 43 })).toBe(false)
  })

  it("denies everything when the user has no entity assignments (fail closed)", () => {
    const none = ctx({ userId: 7, assignedEntities: [] })
    expect(recordInDataScope("entity", employees, none, { entity: "E1" })).toBe(false)
  })
})

describe("record access — branch (Regional manager sees assigned branches)", () => {
  const regional = ctx({ userId: 3, assignedBranches: ["Mumbai", "Pune"] })

  it("allows a record in an assigned branch", () => {
    expect(recordInDataScope("branch", employees, regional, { branch: "Pune" })).toBe(true)
  })

  it("denies a record in an unassigned branch", () => {
    expect(recordInDataScope("branch", employees, regional, { branch: "Delhi" })).toBe(false)
  })

  it("denies with no branch assignments (fail closed)", () => {
    const none = ctx({ userId: 3, assignedBranches: [] })
    expect(recordInDataScope("branch", employees, none, { branch: "Pune" })).toBe(false)
  })
})

describe("record access — none / all (Super Admin sees platform data)", () => {
  const anyone = ctx({ userId: 1 })
  it("none denies every record", () => {
    expect(recordInDataScope("none", employees, anyone, { user_id: 1 })).toBe(false)
  })
  it("all allows every record", () => {
    expect(recordInDataScope("all", employees, anyone, { user_id: 12345 })).toBe(true)
  })
})

describe("SQL predicate — used by list queries and reports", () => {
  it("all -> no predicate (unrestricted)", () => {
    expect(buildDataScopeSql("all", employees, ctx({ userId: 1 }), ALL_COLS)).toBeNull()
  })

  it("none -> 1=0 (blocks all rows)", () => {
    const p = buildDataScopeSql("none", employees, ctx({ userId: 1 }), ALL_COLS)
    expect(p).toEqual({ sql: "1=0", params: [] })
  })

  it("self -> owner columns bound to the user id", () => {
    const p = buildDataScopeSql("self", employees, ctx({ userId: 10 }), ALL_COLS)!
    expect(p.sql).toContain("`user_id` = ?")
    expect(p.sql).toContain("`created_by` = ?")
    expect(p.params).toEqual([10, 10])
  })

  it("team -> owner columns IN (self + subordinates)", () => {
    const p = buildDataScopeSql("team", employees, ctx({ userId: 1, subordinateUserIds: [2, 3] }), ALL_COLS)!
    expect(p.sql).toContain("IN (?,?,?)")
    // one id-list copy per owner column (user_id, created_by)
    expect(p.params).toEqual([1, 2, 3, 1, 2, 3])
  })

  it("team with self only still restricts to the acting user", () => {
    const p = buildDataScopeSql("team", employees, ctx({ userId: 9 }), new Set(["user_id"]), "e")!
    expect(p.sql).toBe("e.`user_id` IN (?)")
    expect(p.params).toEqual([9])
  })

  it("entity -> entity column IN (assignments), with alias", () => {
    const p = buildDataScopeSql(
      "entity",
      employees,
      ctx({ userId: 7, assignedEntities: ["E1", "E2"] }),
      new Set(["entity"]),
      "e",
    )!
    expect(p.sql).toBe("e.`entity` IN (?,?)")
    expect(p.params).toEqual(["E1", "E2"])
  })

  it("branch -> branch column IN (assignments)", () => {
    const p = buildDataScopeSql(
      "branch",
      employees,
      ctx({ userId: 3, assignedBranches: ["Mumbai"] }),
      new Set(["branch"]),
    )!
    expect(p.sql).toBe("`branch` IN (?)")
    expect(p.params).toEqual(["Mumbai"])
  })
})

describe("fail-closed guarantees in SQL (no accidental data exposure)", () => {
  it("self denies when no owner column exists on the table", () => {
    const p = buildDataScopeSql("self", employees, ctx({ userId: 10 }), new Set(["id", "entity"]))
    expect(p).toEqual({ sql: "1=0", params: [] })
  })

  it("team denies when no owner column exists", () => {
    const p = buildDataScopeSql("team", employees, ctx({ userId: 1, subordinateUserIds: [2] }), new Set(["id"]))
    expect(p).toEqual({ sql: "1=0", params: [] })
  })

  it("entity denies when the entity column is absent", () => {
    const p = buildDataScopeSql("entity", employees, ctx({ userId: 7, assignedEntities: ["E1"] }), new Set(["user_id"]))
    expect(p).toEqual({ sql: "1=0", params: [] })
  })

  it("entity denies when the user has no assignments even if the column exists", () => {
    const p = buildDataScopeSql("entity", employees, ctx({ userId: 7, assignedEntities: [] }), new Set(["entity"]))
    expect(p).toEqual({ sql: "1=0", params: [] })
  })

  it("branch denies when the branch column is absent", () => {
    const p = buildDataScopeSql("branch", employees, ctx({ userId: 3, assignedBranches: ["Mumbai"] }), new Set(["entity"]))
    expect(p).toEqual({ sql: "1=0", params: [] })
  })
})

describe("cross-user isolation regression", () => {
  it("a self-scoped user can never see a peer's row via any path", () => {
    const attacker = ctx({ userId: 100 })
    const victimRow = { user_id: 200, created_by: 200, entity: "E1", branch: "Mumbai" }
    // record check rejects it
    expect(recordInDataScope("self", employees, attacker, victimRow)).toBe(false)
    // and the SQL only ever binds the attacker's own id
    const p = buildDataScopeSql("self", employees, attacker, ALL_COLS)!
    expect(p.params.every((v) => v === 100)).toBe(true)
  })
})
