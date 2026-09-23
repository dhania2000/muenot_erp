import { describe, it, expect } from "vitest"
import {
  classifyLink,
  deriveAccessStatus,
  employmentImpliesActive,
  isAccessStatusInSync,
  normalizeEmploymentStatus,
  relationLabel,
  validateLink,
  INACTIVE_EMPLOYMENT_STATUSES,
  type LinkRelation,
} from "@/lib/employee-user-link-core"

/**
 * Phase 4. DB-free proof of the employee ⇄ user mapping model against
 * the six required behaviors:
 *
 *   1. One employee → one user, and user → many employees (multi-entity).
 *   2. Service accounts without employees.
 *   3. Historical users (employment ended, link retained).
 *   4. Multiple entities (same person active in one entity keeps access).
 *   5. Access-status synchronization (derive active/inactive from employment).
 *   6. Link validation guarding the invariants the DB layer relies on.
 */

// -----------------------------------------------------------------------------
// Employment status normalization / activity
// -----------------------------------------------------------------------------
describe("employment status", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeEmploymentStatus("  Ex-Employee ")).toBe("ex-employee")
    expect(normalizeEmploymentStatus(null)).toBe("")
    expect(normalizeEmploymentStatus(undefined)).toBe("")
  })

  it("treats unknown/empty status as active (matches DB default 'Active')", () => {
    expect(employmentImpliesActive("")).toBe(true)
    expect(employmentImpliesActive(null)).toBe(true)
    expect(employmentImpliesActive("Active")).toBe(true)
    expect(employmentImpliesActive("Probation")).toBe(true)
    expect(employmentImpliesActive("Notice Period")).toBe(true)
  })

  it("treats every terminal status as inactive, case-insensitively", () => {
    for (const s of INACTIVE_EMPLOYMENT_STATUSES) {
      expect(employmentImpliesActive(s)).toBe(false)
      expect(employmentImpliesActive(s.toUpperCase())).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------
// Relation classification (Req 1, 2, 3)
// -----------------------------------------------------------------------------
describe("classifyLink", () => {
  it("classifies an active employee with a login as linked", () => {
    expect(classifyLink({ employee: { employmentStatus: "Active" }, user: { accountType: "person" } })).toBe("linked")
  })

  it("classifies an ended-employment link as historical (Req 3)", () => {
    expect(classifyLink({ employee: { employmentStatus: "Ex-Employee" }, user: { accountType: "person" } })).toBe(
      "historical",
    )
  })

  it("classifies an archived employee link as historical even if status looks active", () => {
    expect(classifyLink({ employee: { employmentStatus: "Active", archived: true }, user: { accountType: "person" } })).toBe(
      "historical",
    )
  })

  it("classifies a service login with no employee as a service account (Req 2)", () => {
    expect(classifyLink({ user: { accountType: "service" } })).toBe("service_account")
  })

  it("classifies a person login with no employee as an unlinked user", () => {
    expect(classifyLink({ user: { accountType: "person" } })).toBe("unlinked_user")
  })

  it("classifies an employee with no login as an unlinked employee", () => {
    expect(classifyLink({ employee: { employmentStatus: "Active" } })).toBe("unlinked_employee")
  })

  it("exposes a label and tone for every relation", () => {
    const relations: LinkRelation[] = [
      "linked",
      "historical",
      "service_account",
      "unlinked_user",
      "unlinked_employee",
    ]
    for (const r of relations) {
      const { label, tone } = relationLabel(r)
      expect(label.length).toBeGreaterThan(0)
      expect(["ok", "warn", "muted", "info"]).toContain(tone)
    }
  })
})

// -----------------------------------------------------------------------------
// Access-status synchronization (Req 4, 5)
// -----------------------------------------------------------------------------
describe("deriveAccessStatus", () => {
  it("is inactive when there are no linked employees (lone/service login untouched by caller)", () => {
    expect(deriveAccessStatus([])).toBe("inactive")
  })

  it("is active when the single linked employee is active", () => {
    expect(deriveAccessStatus([{ employmentStatus: "Active" }])).toBe("active")
  })

  it("is inactive when the single linked employee has exited", () => {
    expect(deriveAccessStatus([{ employmentStatus: "Terminated" }])).toBe("inactive")
  })

  it("stays active across multiple entities when ANY employment is active (Req 4)", () => {
    expect(
      deriveAccessStatus([{ employmentStatus: "Ex-Employee" }, { employmentStatus: "Active" }]),
    ).toBe("active")
  })

  it("goes inactive only once every entity's employment has ended (Req 4)", () => {
    expect(
      deriveAccessStatus([{ employmentStatus: "Ex-Employee" }, { employmentStatus: "Resigned" }]),
    ).toBe("inactive")
  })

  it("does not count an archived employee as active on its own", () => {
    expect(deriveAccessStatus([{ employmentStatus: "Active", archived: true }])).toBe("inactive")
    expect(
      deriveAccessStatus([{ employmentStatus: "Active", archived: true }, { employmentStatus: "Active" }]),
    ).toBe("active")
  })

  it("reports in-sync correctly", () => {
    expect(isAccessStatusInSync("active", [{ employmentStatus: "Active" }])).toBe(true)
    expect(isAccessStatusInSync("active", [{ employmentStatus: "Terminated" }])).toBe(false)
    expect(isAccessStatusInSync("inactive", [{ employmentStatus: "Terminated" }])).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Link validation (Req 1, 2, 6) — including employee transfer/offboarding paths
// -----------------------------------------------------------------------------
describe("validateLink", () => {
  it("allows linking a fresh employee to a person login", () => {
    expect(
      validateLink({
        employeeCurrentUserId: null,
        targetUserId: 10,
        targetAccountType: "person",
        sameEntityEmployeeIds: [],
      }),
    ).toEqual({ ok: true })
  })

  it("is idempotent when re-linking to the same login", () => {
    expect(
      validateLink({
        employeeCurrentUserId: 10,
        targetUserId: 10,
        targetAccountType: "person",
        sameEntityEmployeeIds: [],
      }),
    ).toEqual({ ok: true })
  })

  it("refuses to link a service account to an employee (Req 2)", () => {
    const res = validateLink({
      employeeCurrentUserId: null,
      targetUserId: 10,
      targetAccountType: "service",
      sameEntityEmployeeIds: [],
    })
    expect(res.ok).toBe(false)
  })

  it("refuses to re-point an employee already linked to a different login (transfer must unlink first)", () => {
    const res = validateLink({
      employeeCurrentUserId: 7,
      targetUserId: 10,
      targetAccountType: "person",
      sameEntityEmployeeIds: [],
    })
    expect(res.ok).toBe(false)
  })

  it("refuses a duplicate login within the same entity but allows it across entities (Req 1, 4)", () => {
    // Same entity conflict:
    expect(
      validateLink({
        employeeCurrentUserId: null,
        targetUserId: 10,
        targetAccountType: "person",
        sameEntityEmployeeIds: [99],
      }).ok,
    ).toBe(false)
    // Cross-entity is fine (no same-entity conflicts reported):
    expect(
      validateLink({
        employeeCurrentUserId: null,
        targetUserId: 10,
        targetAccountType: "person",
        sameEntityEmployeeIds: [],
      }).ok,
    ).toBe(true)
  })
})
